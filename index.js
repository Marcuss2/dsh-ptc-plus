/**
 * Session-bound REPL for DeepSeek Harness Code Mode.
 *
 * DSH's run_code bridge does not pass session identity to CodeRuntime.run().
 * The tools/execute around-hook carries that identity through AsyncLocalStorage,
 * then this plugin redirects only those runs to a persistent per-session kernel.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import Schema from '@deepseek-ai/schemastery'
import { SessionRuntime } from './internal/session-runtime.js'
import { JOURNAL_KEY, journalsEqual, normalizeJournal, withJournal } from './internal/session-journal.js'
import {
  canonicalizeToolCallStream,
  EDIT_RUN_CODE_EXECUTION_DESCRIPTION,
  EDIT_RUN_CODE_REJECTION_DESCRIPTION,
} from './internal/tool-call-canonicalizer.js'
import {
  capabilityFind,
  capabilityInspect,
  capabilityTree,
  toolCapabilityMetadata,
} from './internal/program-bindings.js'

const RUN_CODE = 'run_code'
const EDIT_RUN_CODE = 'edit_run_code'
const DEFAULT_MAX_NESTED_RUN_CODE_DEPTH = 8
const MAX_TIMER_DELAY_MS = 2_147_483_647
const PLUGIN_PROGRAM_GLOBALS = new Set(['capabilities', 'code', 'repl'])
const REPAIRABLE_DIAGNOSTICS = new Set(['PTC-C001', 'PTC-C002', 'PTC-N001'])
const RUN_CODE_TOOL_DESCRIPTION = 'Evaluate the next TypeScript cell in this session-bound persistent REPL. Earlier top-level bindings remain available, so this call extends the current environment instead of creating a fresh one. Use `code` for the async-function body and `description` for its short UI summary. Only printed or returned values are output. Successful image-bearing subtool results are attached after the cell.'
const RUN_CODE_CODE_DESCRIPTION = 'Code for the next REPL cell, parsed as the body of an async TypeScript function.'
const RUN_CODE_DESCRIPTION_DESCRIPTION = 'Short active-voice summary of what this cell does, 5-10 words (shown in the UI).'
const EDIT_RUN_CODE_DESCRIPTION = 'Repair and execute the most recent eligible run_code cell that was rejected before execution. Replace one exact old_string with new_string; send only the changed text, not the full source. Later inspection cells do not erase the target; a successful edit consumes it.'
const CODE_TRANSPORT_INSTRUCTION = '`run_code` and `edit_run_code` are the only tools callable directly. Call every native tool declared by the SDK from inside a program.'

/** Plugin name used by loader diagnostics. */
export const name = 'ptc-plus'

/** Runtime limits and behavior exposed to Cordis configuration. */
export const Config = Schema.object({
  computeMs: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(60_000)
    .description('Maximum synchronous CPU time for one cell, in milliseconds.'),
  maxWallMs: Schema.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(600_000)
    .description('Maximum elapsed time for one cell, in milliseconds.'),
  maxOutputBytes: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(64 * 1024 * 1024)
    .description('Maximum encoded result and rendered output size in bytes.'),
  maxOldGenerationSizeMb: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(512)
    .description('V8 old-generation memory limit for each session worker, in MiB.'),
  maxValueNodes: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(100_000)
    .description('Maximum nodes in one PTC value graph.'),
  maxValueEdges: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1_000_000)
    .description('Maximum edges in one PTC value graph.'),
  maxValueArrayLength: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1_000_000)
    .description('Maximum declared length of one encoded array.'),
  maxValueBigIntDigits: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(100_000)
    .description('Maximum decimal digits in one encoded BigInt.'),
  maxNestedRunCodeDepth: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_MAX_NESTED_RUN_CODE_DEPTH)
    .description('Maximum recursive code.run depth.'),
  canonicalizeToolCalls: Schema.boolean().default(true)
    .description('Lower known top-level native tool calls into strict Code Mode cells.'),
  looseTopLevelRedeclarations: Schema.boolean().default(true)
    .description('Allow complete top-level const and let declarators to replace existing bindings.'),
  durableReplay: Schema.boolean().default(true)
    .description('Reconstruct durable cells from the session log after a worker restart.'),
})

/** Services required by the plugin. */
export const inject = ['tools', 'codeRuntime', 'systemPrompt', 'llm']

function replGuidance(looseTopLevelRedeclarations, durableReplay) {
  const redeclaration = looseTopLevelRedeclarations
    ? 'Repeated top-level `const`/`let` declarations replace existing bindings.'
    : 'Redeclaring an existing top-level name fails before execution, so reuse it or place one-off declarations inside a block.'
  const recovery = durableReplay
    ? 'Direct Node/OS access remains live but is not replayed after a kernel restart.'
    : ' Durable replay is disabled for this profile. Bindings remain reusable only in the current process; a new kernel starts empty.'
  return `\`run_code\` evaluates consecutive top-level cells in one session-bound persistent REPL.

## session-bound REPL
Reuse earlier top-level bindings instead of resending setup source. ${redeclaration} Capability namespaces are rebound for each cell and must not be retained for later use. ${recovery}`
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function adaptRunCodeSchema(tool) {
  const parameters = tool.parameters
  const properties = isRecord(parameters) ? parameters.properties : undefined
  const code = isRecord(properties) ? properties.code : undefined
  const description = isRecord(properties) ? properties.description : undefined
  if (!isRecord(parameters) || parameters.type !== 'object' || !isRecord(properties)
    || !isRecord(code) || code.type !== 'string'
    || !isRecord(description) || description.type !== 'string') {
    throw new Error('ptc-plus: incompatible run_code schema; expected object parameters with string code and description properties')
  }
  return {
    ...tool,
    description: RUN_CODE_TOOL_DESCRIPTION,
    parameters: {
      ...parameters,
      properties: {
        ...properties,
        code: { ...code, description: RUN_CODE_CODE_DESCRIPTION },
        description: { ...description, description: RUN_CODE_DESCRIPTION_DESCRIPTION },
      },
    },
  }
}

function editRunCodeSchema() {
  return {
    name: EDIT_RUN_CODE,
    description: EDIT_RUN_CODE_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        old_string: {
          type: 'string',
          minLength: 1,
          description: 'Exact text in the rejected cell. It must occur exactly once.',
        },
        new_string: {
          type: 'string',
          description: 'Literal replacement text. Use an empty string to delete the match.',
        },
      },
      required: ['old_string', 'new_string'],
    },
  }
}

function rejectedRunCodeSource(agent) {
  const events = agent?.session?.events
  if (!Array.isArray(events)) return undefined
  const turnStart = events.findLastIndex(event => event?.type === 'turn/start')
  if (turnStart < 0 || events.slice(turnStart + 1).some(event => event?.type === 'turn/end')) return undefined
  for (let index = events.length - 1; index > turnStart; index -= 1) {
    const event = events[index]
    if (event?.type !== 'tool/result') continue
    const callId = event.data?.message?.source?.callId
    if (typeof callId !== 'string') continue
    const call = events.slice(turnStart + 1, index).findLast(candidate =>
      candidate?.type === 'tool/call' && candidate.data?.callId === callId)
    if (call?.data?.name !== RUN_CODE) continue
    let args
    try {
      args = JSON.parse(call.data.arguments)
    } catch {
      return undefined
    }
    let journal
    try {
      journal = normalizeJournal(event.data?.meta?.[JOURNAL_KEY])
    } catch {
      return undefined
    }
    if (args?.description === EDIT_RUN_CODE_REJECTION_DESCRIPTION) continue
    if (journal.status === 'noop'
      && journal.diagnostics.some(diagnostic => REPAIRABLE_DIAGNOSTICS.has(diagnostic.code))) {
      return typeof args?.code === 'string' ? args.code : undefined
    }
    if (args?.description === EDIT_RUN_CODE_EXECUTION_DESCRIPTION) return undefined
  }
  return undefined
}

function sessionId(agent) {
  const id = agent?.session?.id ?? agent?.id
  return id === undefined ? undefined : String(id)
}

function nestedRunCodeArguments(value) {
  if (!isRecord(value)) {
    throw new TypeError('code.run expects an object with code and description strings')
  }
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 2 || !keys.includes('code') || !keys.includes('description')
    || keys.some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))
    || typeof value.code !== 'string' || typeof value.description !== 'string') {
    throw new TypeError('code.run expects exactly code and description string properties')
  }
  return { code: value.code, description: value.description }
}

function namespace(global, functions, errorName, memberNameProperty) {
  return {
    global,
    functions,
    errorClass: { name: errorName, memberNameProperty },
  }
}

function capabilitySdk(nativeSdk) {
  return `${typeof nativeSdk === 'string' ? nativeSdk : ''}

## PTC Plus program capabilities

\`\`\`ts
type ReplStateResult =
  | { names: string[]; mode: "durable" | "volatile"; volatileReason?: string }
  | { action: "save"; name: string; saved: true }
  | { action: "restore"; name?: string; restored: true }
  | { action: "delete"; name: string; deleted: true }
declare const repl: {
  state(args:
    | { action: "list" }
    | { action: "save" | "delete"; name: string }
    | { action: "restore"; name?: string }
  ): Promise<ReplStateResult>
}
declare class CapabilityExplorationError extends Error { readonly operation: "tree" | "find" | "inspect" }
declare const capabilities: {
  tree(): Promise<Array<{ namespace: string; members: string[] }>>
  find(query: string): Promise<Array<{ symbol: string; description?: string; completeness: string; effect: string; replay: string }>>
  inspect(args?: { symbols?: string[]; budget?: number }): Promise<{ symbols: JsonValue[]; omitted: number; unknown: string[]; budget: number }>
}

declare class CodeExecutionError extends Error { readonly operation: "run" }
declare const code: {
  run(args: { code: string; description: string }): Promise<{ logs: string[]; result?: JsonValue }>
}
\`\`\``
}

/** Register the session-bound REPL runtime. */
export function apply(ctx, config = {}) {
  if (ctx.codeRuntime.language !== 'typescript') {
    throw new Error(`ptc-plus: unsupported code runtime language ${JSON.stringify(ctx.codeRuntime.language)}; only "typescript" is supported`)
  }

  const maxNestedRunCodeDepth = config.maxNestedRunCodeDepth ?? DEFAULT_MAX_NESTED_RUN_CODE_DEPTH
  if (!Number.isSafeInteger(maxNestedRunCodeDepth) || maxNestedRunCodeDepth < 1) {
    throw new TypeError('ptc-plus: maxNestedRunCodeDepth must be a positive safe integer')
  }
  const {
    maxNestedRunCodeDepth: _nestedDepth,
    canonicalizeToolCalls: _canonicalizeToolCalls,
    ...sessionConfig
  } = config
  const canonicalizeToolCalls = config.canonicalizeToolCalls ?? true
  if (typeof canonicalizeToolCalls !== 'boolean') {
    throw new TypeError('ptc-plus: canonicalizeToolCalls must be a boolean')
  }
  const looseTopLevelRedeclarations = config.looseTopLevelRedeclarations ?? true
  const scope = new AsyncLocalStorage()
  const sessions = new SessionRuntime(sessionConfig)
  const runtime = ctx.codeRuntime
  const ownRun = Object.getOwnPropertyDescriptor(runtime, 'run')
  const upstreamRun = runtime.run
  const patchedDefinitions = new Map()
  const pending = new WeakMap()
  const canonicalRequests = new WeakMap()
  const canonicalSessions = new Map()
  let active = true

  const projectBindings = (request, depth, executionToken, inheritedTools = undefined) => {
    const lease = { active: true }
    const release = () => { lease.active = false }
    if (!Array.isArray(request.bindings)) return { request, release }
    const conflicts = request.bindings
      .map(binding => binding?.global)
      .filter(global => PLUGIN_PROGRAM_GLOBALS.has(global))
    if (conflicts.length > 0) {
      throw new Error(`ptc-plus: request binding conflicts with reserved program namespace ${JSON.stringify(conflicts[0])}`)
    }
    const toolsNamespace = request.bindings.find(binding => binding?.global === 'tools')
    const functions = inheritedTools ?? (
      toolsNamespace?.functions !== null && typeof toolsNamespace?.functions === 'object'
        ? toolsNamespace.functions
        : Object.create(null)
    )
    const ensureLease = () => {
      if (!lease.active) throw new Error('PTC execution lease expired')
    }
    const runCode = async (value) => {
      ensureLease()
      const args = nestedRunCodeArguments(value)
      if (depth >= maxNestedRunCodeDepth) {
        throw new RangeError(`code.run recursion depth exceeds configured maximum ${maxNestedRunCodeDepth}`)
      }
      if (typeof functions[RUN_CODE] === 'function') return functions[RUN_CODE](args)
      const childProjected = projectBindings(
        { ...request, program: args.code }, depth + 1, executionToken, functions,
      )
      let child
      try {
        child = await upstreamRun.call(runtime, childProjected.request)
      } finally {
        childProjected.release()
      }
      if (child.error !== undefined) {
        throw new Error(`nested run_code failed (${child.error.kind}): ${child.error.message}`)
      }
      return { logs: child.logs, ...(child.value === undefined ? {} : { result: child.value }) }
    }

    const projected = request.bindings.map(binding => {
        const wrapped = Object.create(null)
        for (const key of Reflect.ownKeys(binding.functions ?? {})) {
          if (typeof key !== 'string' || typeof binding.functions[key] !== 'function') continue
          Object.defineProperty(wrapped, key, {
            enumerable: true,
            value: async (...args) => {
              ensureLease()
              return binding.functions[key](...args)
            },
          })
        }
        return { ...binding, functions: wrapped }
      })
    const schemas = (typeof ctx.tools.schemas === 'function' ? ctx.tools.schemas(executionToken?.agent) : [])
      .filter(schema => schema?.name === RUN_CODE || typeof functions[schema?.name] === 'function')
    const annotations = Object.fromEntries(schemas.flatMap(schema => {
      return typeof schema?.name === 'string' && schema.name !== RUN_CODE
        ? [[schema.name, { replay: 'recorded-value' }]]
        : []
    }))
    const metadata = toolCapabilityMetadata(schemas, annotations)
    projected.push(namespace('capabilities', {
      tree: async value => {
        if (value !== undefined) throw new TypeError('capabilities.tree does not accept arguments')
        ensureLease()
        return capabilityTree(metadata)
      },
      find: async value => {
        ensureLease()
        if (typeof value !== 'string') throw new TypeError('capabilities.find expects a query string')
        return capabilityFind(metadata, value)
      },
      inspect: async value => {
        ensureLease()
        if (value === undefined) return capabilityInspect(metadata)
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new TypeError('capabilities.inspect expects an object')
        }
        return capabilityInspect(metadata, value.symbols, value.budget)
      },
    }, 'CapabilityExplorationError', 'operation'))
    projected.push(namespace('code', { run: runCode }, 'CodeExecutionError', 'operation'))
    return { request: { ...request, bindings: projected }, release }
  }

  const patchResultMetadata = (agent) => {
    const definition = ctx.tools.get(RUN_CODE, agent)
    if (definition === undefined) {
      throw new Error('ptc-plus: run_code definition is unavailable for the owning session')
    }
    if (definition.output === undefined) {
      throw new Error('ptc-plus: run_code definition has no output projection')
    }
    if (patchedDefinitions.has(definition)) return
    const output = definition.output
    const original = output.presentationMeta
    const patched = (args, value) => {
      if (!active) return original === undefined ? undefined : original(args, value)
      const base = original === undefined ? undefined : original(args, value)
      const current = scope.getStore()
      return current?.journal === undefined ? base : withJournal(base, current.journal)
    }
    try {
      Object.defineProperty(output, 'presentationMeta', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: patched,
      })
      patchedDefinitions.set(definition, { output, original, patched })
    } catch (error) {
      throw new Error(`ptc-plus: cannot attach the session journal to run_code results: ${error.message}`)
    }
  }

  const patchedRun = function (request) {
    if (!active) return upstreamRun.call(runtime, request)
    const current = scope.getStore()
    if (current === undefined) return upstreamRun.call(runtime, request)
    const projected = projectBindings(request, 0, current)
    return sessions.run(current, { ...projected.request, executionToken: current }).finally(projected.release)
  }

  Object.defineProperty(runtime, 'run', {
    configurable: true,
    writable: true,
    value: patchedRun,
  })

  ctx.systemPrompt.section({
    name: 'tools:ptc-plus-repl',
    order: 98,
    text: context => ctx.tools.get(RUN_CODE, context.scope) === undefined
      ? ''
      : replGuidance(looseTopLevelRedeclarations, sessions.config.durableReplay),
  })

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const tools = assembly.tools
    if (!Array.isArray(tools)) {
      throw new Error('ptc-plus: incompatible prompt assembly; expected a tools array')
    }
    if (!tools.some(tool => tool?.name === RUN_CODE)) return assembly
    const strictPtc = tools.length === 1 && tools[0]?.name === RUN_CODE
    const runCode = strictPtc ? tools[0] : undefined
    const nativeSchemas = new Map(
      (strictPtc && typeof ctx.tools.schemas === 'function' ? ctx.tools.schemas(context.scope) : [])
        .filter(schema => typeof schema?.name === 'string' && schema.name !== RUN_CODE)
        .map(schema => [schema.name, schema]),
    )
    if (strictPtc && nativeSchemas.has(EDIT_RUN_CODE)) {
      throw new Error(`ptc-plus: reserved code-edit transport ${JSON.stringify(EDIT_RUN_CODE)} conflicts with a native tool`)
    }
    const id = sessionId(context?.agent)
    const repairSource = strictPtc && id !== undefined ? rejectedRunCodeSource(context.agent) : undefined
    if (id !== undefined) {
      if (strictPtc) canonicalSessions.set(id, { nativeSchemas, repairSource })
      else canonicalSessions.delete(id)
    }
    if (context?.signal !== null && typeof context?.signal === 'object') {
      if (strictPtc && id !== undefined) {
        canonicalRequests.set(context.signal, { sessionId: id, nativeSchemas, repairSource })
      }
      else canonicalRequests.delete(context.signal)
    }
    return {
      ...assembly,
      tools: strictPtc && id !== undefined
        ? [adaptRunCodeSchema(runCode), editRunCodeSchema()]
        : tools.map(tool => tool?.name === RUN_CODE ? adaptRunCodeSchema(tool) : tool),
      sections: !strictPtc || !Array.isArray(assembly.sections)
        ? assembly.sections
        : assembly.sections.map(section => {
            if (section?.name === 'tools:sdk') return { ...section, text: capabilitySdk(section.text) }
            if (id !== undefined && section?.name === 'tools:code-only') {
              return { ...section, text: CODE_TRANSPORT_INSTRUCTION }
            }
            return section
          }),
    }
  })

  ctx.on('llm/stream', (options, next) => {
    const request = options?.signal !== null && typeof options?.signal === 'object'
      ? canonicalRequests.get(options.signal)
      : undefined
    const optionSessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
    const canonical = request === undefined
      ? (options?.signal === undefined && optionSessionId !== undefined
          ? canonicalSessions.get(optionSessionId)
          : undefined)
      : optionSessionId === request.sessionId ? request : undefined
    if (canonical === undefined) return next()
    return canonicalizeToolCallStream(next(), {
      tools: options.tools,
      nativeSchemas: canonicalizeToolCalls ? canonical.nativeSchemas : new Map(),
      editToolName: EDIT_RUN_CODE,
      repairSource: canonical.repairSource,
    })
  }, { global: true })

  ctx.on('tools/execute', (exec, next) => {
    if (exec.name !== RUN_CODE) return next()
    if (exec.parent !== undefined) return scope.run(undefined, next)
    const id = sessionId(exec.agent)
    if (id === undefined) return next()
    patchResultMetadata(exec.agent)
    const current = { id, callId: String(exec.callId), session: exec.agent?.session, agent: exec.agent }
    pending.set(exec, current)
    return scope.run(current, async () => {
      const result = await next()
      if (result?.isError === true && current.journal !== undefined) {
        return { ...result, meta: withJournal(result.meta, current.journal) }
      }
      return result
    })
  })

  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== RUN_CODE) return
    if (exec.parent !== undefined) return
    const id = sessionId(exec.agent)
    if (id === undefined) return
    const current = pending.get(exec)
    pending.delete(exec)
    if (current?.journal === undefined) {
      sessions.noteNoop(id, exec.callId)
      return
    }
    const meta = result?.meta
    const confirmed = meta !== null && typeof meta === 'object' && !Array.isArray(meta)
      && Object.hasOwn(meta, JOURNAL_KEY)
      && journalsEqual(meta[JOURNAL_KEY], current.journal)
    sessions.finalize(current, confirmed)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const id = sessionId(agent)
    if (id !== undefined) canonicalSessions.delete(id)
    return sessions.disposeSession(sessionId(agent) ?? String(agent.id))
  })
  ctx.on('session/disposed', (session) => {
    canonicalSessions.delete(String(session.id))
    return sessions.disposeSession(String(session.id))
  })

  ctx.effect(() => async () => {
    active = false
    if (runtime.run === patchedRun) {
      if (ownRun === undefined) delete runtime.run
      else Object.defineProperty(runtime, 'run', ownRun)
    }
    for (const { output, original, patched } of patchedDefinitions.values()) {
      if (output.presentationMeta !== patched) continue
      if (original === undefined) delete output.presentationMeta
      else output.presentationMeta = original
    }
    patchedDefinitions.clear()
    canonicalSessions.clear()
    await sessions.dispose()
  }, 'ptc-plus session runtime teardown')
}
