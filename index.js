/**
 * Session-bound REPL for DeepSeek Harness Code Mode.
 *
 * DSH's run_code bridge does not pass session identity to CodeRuntime.run().
 * The tools/execute around-hook carries that identity through AsyncLocalStorage,
 * then this plugin redirects only those runs to a persistent per-session kernel.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { SessionRuntime } from './internal/session-runtime.js'
import { JOURNAL_KEY, journalsEqual, withJournal } from './internal/session-journal.js'

const RUN_CODE = 'run_code'
const DEFAULT_MAX_NESTED_RUN_CODE_DEPTH = 8
const RUN_CODE_TOOL_DESCRIPTION = 'Evaluate the next TypeScript cell in this session-bound persistent REPL. Earlier top-level bindings remain available, so this call extends the current environment instead of creating a fresh one. Use `code` for the async-function body and `description` for its short UI summary. Only printed or returned values are output. Successful image-bearing subtool results are attached after the cell.'
const RUN_CODE_CODE_DESCRIPTION = 'Code for the next REPL cell, parsed as the body of an async TypeScript function.'
const RUN_CODE_DESCRIPTION_DESCRIPTION = 'Short active-voice summary of what this cell does, 5-10 words (shown in the UI).'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ptc-plus'

/** Services required by the plugin. */
export const inject = ['tools', 'codeRuntime', 'systemPrompt']

function replGuidance(looseTopLevelRedeclarations) {
  const redeclaration = looseTopLevelRedeclarations
    ? 'Repeated top-level `const`/`let` variable declarations replace existing bindings; reuse a name naturally when recomputing it.'
    : 'Redeclaring an existing top-level name fails before execution, so reuse it or place one-off declarations inside a block.'
  return `\`run_code\` evaluates consecutive top-level cells in one session-bound persistent REPL.

## session-bound REPL
Reuse existing top-level bindings and do not resend setup source. ${redeclaration} Use the current \`workspace\`, \`code\`, and \`host\` capability globals; they are rebound for every cell, so never retain an individual capability function. Direct non-journalable Node/process access changes only cold recovery; live bindings remain usable. Follow \`[PTC-...]\` \`help:\` lines and retry only the failing part. Use \`code.run({ code, description })\` to execute source constructed or transformed by this cell in an isolated child environment; it returns \`{ logs, result? }\`. Historical source may be read through available session-event capabilities and edited with ordinary TypeScript.`
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

function exactObject(value, fields, label) {
  if (!isRecord(value)) throw new TypeError(`${label} expects an object`)
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || !fields.has(key)
    || !Object.prototype.propertyIsEnumerable.call(value, key))) {
    throw new TypeError(`${label} received unknown or non-enumerable fields`)
  }
  return value
}

function readLinesArguments(value) {
  exactObject(value, new Set(['path', 'offset', 'limit']), 'workspace.readLines')
  if (typeof value.path !== 'string' || value.path.trim().length === 0) {
    throw new TypeError('workspace.readLines path must be a non-empty string')
  }
  for (const name of ['offset', 'limit']) {
    if (value[name] !== undefined && (!Number.isSafeInteger(value[name]) || value[name] < 1)) {
      throw new TypeError(`workspace.readLines ${name} must be a positive integer`)
    }
  }
  return {
    file_path: value.path,
    ...(value.offset === undefined ? {} : { offset: value.offset }),
    ...(value.limit === undefined ? {} : { limit: value.limit }),
  }
}

function hostInvokeArguments(value) {
  exactObject(value, new Set(['name', 'args']), 'host.invoke')
  if (typeof value.name !== 'string' || value.name.length === 0 || !Object.hasOwn(value, 'args')) {
    throw new TypeError('host.invoke expects non-empty name and args properties')
  }
  return { name: value.name, args: value.args }
}

function namespace(global, functions, errorName, memberNameProperty) {
  return {
    global,
    functions,
    errorClass: { name: errorName, memberNameProperty },
  }
}

function capabilitySdk(names) {
  const available = new Set(names)
  const compatibility = [...available].filter(name => !['read', RUN_CODE].includes(name)).sort()
  const hostNames = compatibility.length === 0 ? 'never' : compatibility.map(JSON.stringify).join(' | ')
  const workspace = available.has('read')
    ? `interface WorkspaceLine { number: number; text: string }
interface WorkspaceLines { path: string; offset: number; lines: WorkspaceLine[]; totalLines: number }
declare class WorkspaceError extends Error { readonly operation: "readLines" }
declare const workspace: {
  readLines(args: { path: string; offset?: number; limit?: number }): Promise<WorkspaceLines>
}`
    : ''
  return `## Program capabilities

Only \`run_code\` is model-callable. Inside a cell, use these program APIs; do not emit native tool calls or \`tools.*\` expressions. Capability objects are rebound for each cell.

\`\`\`ts
type HostJson = null | boolean | number | string | HostJson[] | { [key: string]: HostJson }
${workspace}

declare class CodeExecutionError extends Error { readonly operation: "run" }
declare const code: {
  run(args: { code: string; description: string }): Promise<{ logs: string[]; result?: HostJson }>
}

type HostCapabilityName = ${hostNames}
declare class HostCapabilityError extends Error { readonly operation: "invoke" }
declare const host: {
  invoke(call: { name: HostCapabilityName; args: HostJson }): Promise<HostJson>
}
\`\`\`

\`workspace.readLines\` is intentionally bounded and never claims to return a complete file. \`host.invoke\` is the explicit compatibility path for unadapted capabilities.`
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
  const { maxNestedRunCodeDepth: _nestedDepth, ...sessionConfig } = config
  const looseTopLevelRedeclarations = config.looseTopLevelRedeclarations ?? true
  const scope = new AsyncLocalStorage()
  const sessions = new SessionRuntime(sessionConfig)
  const runtime = ctx.codeRuntime
  const ownRun = Object.getOwnPropertyDescriptor(runtime, 'run')
  const upstreamRun = runtime.run
  const patchedDefinitions = new Map()
  const pending = new WeakMap()

  const projectBindings = (request, depth, inheritedTools = undefined) => {
    const lease = { active: true }
    const release = () => { lease.active = false }
    if (!Array.isArray(request.bindings)) return { request, release }
    const toolsNamespace = request.bindings.find(binding => binding?.global === 'tools')
    const functions = inheritedTools ?? toolsNamespace?.functions
    if (functions === null || typeof functions !== 'object') return { request, release }
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
      const childProjected = projectBindings({ ...request, program: args.code }, depth + 1, functions)
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

    const projected = request.bindings.filter(binding => !['tools', 'workspace', 'code', 'host'].includes(binding?.global))
    if (typeof functions.read === 'function') {
      projected.push(namespace(
        'workspace',
        { readLines: value => { ensureLease(); return functions.read(readLinesArguments(value)) } },
        'WorkspaceError',
        'operation',
      ))
    }
    projected.push(namespace('code', { run: runCode }, 'CodeExecutionError', 'operation'))
    const compatible = new Map()
    for (const key of Reflect.ownKeys(functions)) {
      if (typeof key !== 'string' || ['read', RUN_CODE].includes(key) || typeof functions[key] !== 'function') continue
      compatible.set(key, functions[key])
    }
    projected.push(namespace('host', {
      invoke(value) {
        ensureLease()
        const call = hostInvokeArguments(value)
        const binding = compatible.get(call.name)
        if (binding === undefined) throw new RangeError(`host capability ${JSON.stringify(call.name)} is unavailable`)
        return binding(call.args)
      },
    }, 'HostCapabilityError', 'operation'))
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
    const current = scope.getStore()
    if (current === undefined) return upstreamRun.call(runtime, request)
    const projected = projectBindings(request, 0)
    return sessions.run(current, projected.request).finally(projected.release)
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
      : replGuidance(looseTopLevelRedeclarations),
  })

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const tools = assembly.tools
    if (!Array.isArray(tools)) {
      throw new Error('ptc-plus: incompatible prompt assembly; expected a tools array')
    }
    if (!tools.some(tool => tool?.name === RUN_CODE)) return assembly
    const strictPtc = tools.length === 1 && tools[0]?.name === RUN_CODE
    const schemas = strictPtc && typeof ctx.tools.schemas === 'function'
      ? ctx.tools.schemas(context.scope)
      : []
    const names = schemas.map(schema => schema?.name).filter(name => typeof name === 'string')
    const hasRead = names.includes('read')
    return {
      ...assembly,
      tools: tools.map(tool => tool?.name === RUN_CODE ? adaptRunCodeSchema(tool) : tool),
      sections: !strictPtc || !Array.isArray(assembly.sections)
        ? assembly.sections
        : assembly.sections
            .filter(section => !(hasRead && section?.name === 'tool:read'))
            .map(section => section?.name === 'tools:sdk'
              ? { ...section, text: capabilitySdk(names) }
              : section),
    }
  })

  ctx.on('tools/execute', (exec, next) => {
    if (exec.name !== RUN_CODE) return next()
    if (exec.parent !== undefined) return scope.run(undefined, next)
    const id = sessionId(exec.agent)
    if (id === undefined) return next()
    patchResultMetadata(exec.agent)
    const current = { id, callId: String(exec.callId), session: exec.agent?.session }
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
    return sessions.disposeSession(sessionId(agent) ?? String(agent.id))
  })
  ctx.on('session/disposed', (session) => {
    return sessions.disposeSession(String(session.id))
  })

  ctx.effect(() => async () => {
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
    await sessions.dispose()
  }, 'ptc-plus session runtime teardown')
}
