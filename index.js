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

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ptc-plus'

/** Services required by the plugin. */
export const inject = ['tools', 'codeRuntime', 'systemPrompt']

const REPL_GUIDANCE = `## Session-bound run_code REPL

\`run_code\` is a session-bound REPL. Top-level imports, variables, functions, and live values remain available to later calls, so reuse bindings directly instead of resending source. Replayable computation is durable in the session log. Code that needs non-journalable Node capabilities automatically enters a live-only volatile segment without a retry; after a restart the last durable state is restored and skipped volatile source is reported. The \`tools\` SDK is rebound for every call: functions may use the current global \`tools\`, but do not save an individual tool function for later. Use \`repl.state({action,name?})\` to list, save, restore, or delete human-readable durable states.`

function sessionId(agent) {
  const id = agent?.session?.id ?? agent?.id
  return id === undefined ? undefined : String(id)
}

/** Register the session-bound REPL runtime. */
export function apply(ctx, config = {}) {
  if (ctx.codeRuntime.language !== 'typescript') {
    throw new Error(`ptc-plus: unsupported code runtime language ${JSON.stringify(ctx.codeRuntime.language)}; only "typescript" is supported`)
  }

  const scope = new AsyncLocalStorage()
  const sessions = new SessionRuntime(config)
  const runtime = ctx.codeRuntime
  const ownRun = Object.getOwnPropertyDescriptor(runtime, 'run')
  const upstreamRun = runtime.run
  const patchedDefinitions = new Map()
  const pending = new WeakMap()

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
    return sessions.run(current, request)
  }

  Object.defineProperty(runtime, 'run', {
    configurable: true,
    writable: true,
    value: patchedRun,
  })

  ctx.systemPrompt.section({
    name: 'tools:ptc-plus-repl',
    order: 151,
    text: context => ctx.tools.get(RUN_CODE, context.scope) === undefined ? '' : REPL_GUIDANCE,
  })

  ctx.on('tools/execute', (exec, next) => {
    if (exec.name !== RUN_CODE) return next()
    const id = sessionId(exec.agent)
    if (id === undefined) return next()
    patchResultMetadata(exec.agent)
    const current = { id, session: exec.agent?.session }
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
