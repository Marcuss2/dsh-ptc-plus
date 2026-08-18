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

const REPL_GUIDANCE = `\`run_code\` evaluates consecutive top-level cells in one session-bound persistent REPL.

## session-bound REPL
Reuse existing top-level bindings and do not resend setup source. Redeclaring an existing top-level name fails before execution, so reuse it or place one-off declarations inside a block. Use the current global \`tools.*\`; it is rebound for every cell, so never retain an individual tool function. Direct non-journalable Node/process access changes only cold recovery; live bindings remain usable. Follow \`[PTC-...]\` \`help:\` lines and retry only the failing part. Use \`tools.run_code({ code, description })\` to execute source constructed or transformed by this cell in an isolated child environment; it returns \`{ logs, result? }\`. Historical source may be read through available session-event tools and edited with ordinary TypeScript.`

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
    throw new TypeError('tools.run_code expects an object with code and description strings')
  }
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 2 || !keys.includes('code') || !keys.includes('description')
    || keys.some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))
    || typeof value.code !== 'string' || typeof value.description !== 'string') {
    throw new TypeError('tools.run_code expects exactly code and description string properties')
  }
  return { code: value.code, description: value.description }
}

function cloneFunctionsWith(functions, member, binding) {
  const clone = Object.create(Object.getPrototypeOf(functions))
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(functions))
  Object.defineProperty(clone, member, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: binding,
  })
  return clone
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
  const scope = new AsyncLocalStorage()
  const sessions = new SessionRuntime(sessionConfig)
  const runtime = ctx.codeRuntime
  const ownRun = Object.getOwnPropertyDescriptor(runtime, 'run')
  const upstreamRun = runtime.run
  const patchedDefinitions = new Map()
  const pending = new WeakMap()

  const withRunCodeBinding = (request, depth) => {
    if (!Array.isArray(request.bindings)) return request
    const toolsIndex = request.bindings.findIndex(namespace => namespace?.global === 'tools')
    const toolsNamespace = toolsIndex < 0 ? undefined : request.bindings[toolsIndex]
    const functions = toolsNamespace?.functions
    if (functions !== null && typeof functions === 'object' && Object.hasOwn(functions, RUN_CODE)) {
      return request
    }
    const runCode = async (value) => {
      const args = nestedRunCodeArguments(value)
      if (depth >= maxNestedRunCodeDepth) {
        throw new RangeError(`tools.run_code recursion depth exceeds configured maximum ${maxNestedRunCodeDepth}`)
      }
      const childRequest = withRunCodeBinding({ ...request, program: args.code }, depth + 1)
      const child = await upstreamRun.call(runtime, childRequest)
      if (child.error !== undefined) {
        throw new Error(`nested run_code failed (${child.error.kind}): ${child.error.message}`)
      }
      return { logs: child.logs, ...(child.value === undefined ? {} : { result: child.value }) }
    }
    if (toolsIndex < 0) {
      return {
        ...request,
        bindings: [...request.bindings, {
          global: 'tools',
          functions: { [RUN_CODE]: runCode },
          errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
        }],
      }
    }
    if (functions === null || typeof functions !== 'object') return request
    const bindings = [...request.bindings]
    bindings[toolsIndex] = {
      ...toolsNamespace,
      functions: cloneFunctionsWith(functions, RUN_CODE, runCode),
    }
    return { ...request, bindings }
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
    return sessions.run(current, withRunCodeBinding(request, 0))
  }

  Object.defineProperty(runtime, 'run', {
    configurable: true,
    writable: true,
    value: patchedRun,
  })

  ctx.systemPrompt.section({
    name: 'tools:ptc-plus-repl',
    order: 98,
    text: context => ctx.tools.get(RUN_CODE, context.scope) === undefined ? '' : REPL_GUIDANCE,
  })

  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    const tools = assembly.tools
    if (!Array.isArray(tools)) {
      throw new Error('ptc-plus: incompatible prompt assembly; expected a tools array')
    }
    if (!tools.some(tool => tool?.name === RUN_CODE)) return assembly
    return {
      ...assembly,
      tools: tools.map(tool => tool?.name === RUN_CODE ? adaptRunCodeSchema(tool) : tool),
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
