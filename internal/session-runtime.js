import { diagnostic, renderDiagnostic } from './diagnostic.js'
import { createFailureTracker, messageOf } from './failure-reporting.js'
import {
  appendRecoveryBoundary,
  createJournal,
  liveToolCallSeq,
  normalizeJournal,
  pathToHead,
  reduceStateOperations,
  recoverJournal,
} from './session-journal.js'
import { normalizeBindingDescriptors } from './binding-descriptors.js'
import { validateMaxWallMs } from './runtime-config.js'
import { WorkerClient } from './worker-client.js'
import { BindingCatalog, durabilityState, transitionDurability } from './session-state.js'
import { SessionCellExecutor } from './session-cell-executor.js'

const WORKER_URL = new URL('./kernel-worker.js', import.meta.url)
const DEFAULTS = Object.freeze({
  computeMs: 60_000,
  maxWallMs: 600_000,
  maxOutputBytes: 64 * 1024 * 1024,
  maxOldGenerationSizeMb: 512,
  maxValueNodes: 100_000,
  maxValueEdges: 1_000_000,
  maxValueArrayLength: 1_000_000,
  maxValueBigIntDigits: 100_000,
  looseTopLevelRedeclarations: true,
  durableReplay: true,
  autoRewriteImports: true,
  autoStripExports: true,
  autoSplitRedeclarations: true,
  tipsEnabled: true,
  tipCooldownMessages: 3,
  tipEscalationFailures: 2,
})

function recoveryDiagnostic(count) {
  return diagnostic({
    code: 'PTC-R002',
    severity: 'warning',
    phase: 'recover',
    message: `Restored the durable head and skipped ${count} unreconstructable historical cell(s); their source remains in the session log.`,
    stateEffect: 'rolled-back',
    help: [
      'continue from the restored bindings',
      'do not reference values created only in the skipped suffix',
    ],
  })
}

function resolveConfig(config) {
  const resolved = { ...DEFAULTS, ...config }
  for (const key of [
    'computeMs', 'maxOutputBytes', 'maxOldGenerationSizeMb',
    'maxValueNodes', 'maxValueEdges', 'maxValueArrayLength', 'maxValueBigIntDigits',
  ]) {
    const value = resolved[key]
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`ptc-plus: ${key} must be a positive safe integer`)
    }
  }
  validateMaxWallMs(resolved.maxWallMs)
  for (const key of [
    'looseTopLevelRedeclarations', 'durableReplay', 'autoRewriteImports',
    'autoStripExports', 'autoSplitRedeclarations', 'tipsEnabled',
  ]) {
    if (typeof resolved[key] !== 'boolean') {
      throw new TypeError(`ptc-plus: ${key} must be a boolean`)
    }
  }
  for (const key of ['tipCooldownMessages', 'tipEscalationFailures']) {
    const value = resolved[key]
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`ptc-plus: ${key} must be a positive safe integer`)
    }
  }
  return resolved
}

function rewritePolicy(config) {
  return {
    autoRewriteImports: config.autoRewriteImports,
    autoStripExports: config.autoStripExports,
    autoSplitRedeclarations: config.autoSplitRedeclarations,
  }
}

function emptyHistory() {
  return { nodes: [], head: undefined, checkpoints: new Map(), volatileSuffix: [], available: true }
}

class ReplayFailure extends Error {
  constructor(node, cause) {
    super(messageOf(cause))
    this.node = node
  }
}

class ReplayCancelled extends Error {
  constructor(result) {
    super(result.error?.message ?? 'session replay cancelled')
    this.result = result
  }
}

class SessionKernel {
  constructor({ config, history, cwd, session, withInitiator }) {
    this.config = config
    this.history = history
    this.cwd = cwd
    this.session = session
    this.withInitiator = withInitiator
    this.durability = durabilityState()
    this.bindingCatalog = new BindingCatalog()
    this.replayed = false
    this.recoveryNotice = history.volatileSuffix.length === 0
      ? undefined
      : recoveryDiagnostic(history.volatileSuffix.length)
    this.active = undefined
    this.sequence = 0
    this.tail = Promise.resolve()
    this.tentatives = new WeakMap()
    this.cellExecutor = new SessionCellExecutor(this)
    this.client = new WorkerClient({
      workerUrl: WORKER_URL,
      cwd,
      maxOldGenerationSizeMb: config.maxOldGenerationSizeMb,
      onMessage: message => this.cellExecutor.onMessage(message),
      onFailure: message => this.active?.resolve({
        logs: [], error: { kind: 'worker-exit', message },
      }, true),
    })
    this.failures = createFailureTracker()
    this.disposed = false
  }

  valueLimits() {
    return {
      maxNodes: this.config.maxValueNodes,
      maxEdges: this.config.maxValueEdges,
      maxArrayLength: this.config.maxValueArrayLength,
      maxBigIntDigits: this.config.maxValueBigIntDigits,
      maxStringBytes: this.config.maxOutputBytes,
    }
  }

  rewritePolicy() {
    return rewritePolicy(this.config)
  }

  run(request) {
    const execute = () => this.execute(request)
    const result = this.tail.then(execute, execute)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  async execute(request) {
    if (!this.replayed) {
      let skipped = 0
      while (!this.replayed) {
        try {
          await this.replayHistory(request)
          this.replayed = true
        } catch (error) {
          const worker = this.client.worker
          if (worker !== undefined) await this.client.reset(worker)
          if (error instanceof ReplayCancelled) {
            this.completeJournal(request.journal, 'noop', error.result)
            return error.result
          }
          if (!(error instanceof ReplayFailure)) {
            const result = {
              logs: [],
              error: {
                kind: 'recovery',
                message: `cannot reconstruct REPL from session log: ${messageOf(error)}`,
              },
            }
            this.completeJournal(request.journal, 'noop', result)
            return result
          }
          const frontier = error.node.parent === undefined
            ? undefined
            : this.history.nodes[error.node.parent]
          const previousPathLength = pathToHead(this.history).length
          try {
            appendRecoveryBoundary(this.session, error.node, frontier)
            this.history = recoverJournal(this.session, request.callSeq)
          } catch (boundaryError) {
            const result = {
              logs: [],
              error: {
                kind: 'recovery',
                message: `cannot persist REPL recovery boundary: ${messageOf(boundaryError)}`,
              },
            }
            this.completeJournal(request.journal, 'noop', result)
            return result
          }
          const nextPathLength = pathToHead(this.history).length
          skipped += Math.max(1, previousPathLength - nextPathLength)
          this.durability = durabilityState()
        }
      }
      if (skipped > 0) this.recoveryNotice = recoveryDiagnostic(skipped)
    }
    const notices = []
    if (this.recoveryNotice !== undefined) {
      notices.push(this.recoveryNotice)
      this.recoveryNotice = undefined
    }
    const leadingDiagnostics = notices.splice(0)
    if (request.journal !== undefined) request.journal.diagnostics.push(...leadingDiagnostics)
    const result = await this.cellExecutor.executeCell(request)
    if (leadingDiagnostics.length > 0) {
      const rendered = leadingDiagnostics.map(item => renderDiagnostic(item, request.program))
      result.logs = [...rendered, ...result.logs]
    }
    if (result.error === undefined) {
      this.failures.reset()
    } else {
      const hint = this.failures.hint(result.error)
      if (hint !== undefined) {
        result.logs = [...result.logs, renderDiagnostic(hint, request.program)]
        if (request.journal !== undefined) request.journal.diagnostics.push(hint)
      }
    }
    return result
  }

  async replayHistory(request) {
    this.bindingCatalog = new BindingCatalog()
    const path = pathToHead(this.history)
    for (const node of path) {
      try {
        const result = await this.cellExecutor.executeCell({ ...request, program: node.code, journal: undefined }, node.journal)
        const completion = node.journal.completion
        if (result.error !== undefined && !['exception', 'invalid-output'].includes(result.error.kind)) {
          if (result.error.kind === 'abort') throw new ReplayCancelled(result)
          throw new Error(`cell replay infrastructure failed (${result.error.kind}): ${result.error.message}`)
        }
        if (completion.kind === 'return' && result.error !== undefined) {
          throw new Error(`cell replay failed: ${result.error.message}`)
        }
        if (completion.kind === 'throw') {
          if (result.error === undefined) throw new Error('cell replay succeeded where the recorded cell failed')
          if (result.error.kind !== completion.error.kind || result.error.message !== completion.error.message) {
            throw new Error('cell replay produced a different semantic failure')
          }
        }
      } catch (error) {
        if (error instanceof ReplayCancelled) throw error
        throw new ReplayFailure(node, error)
      }
    }
  }

  completeJournal(journal, status, result, volatileReason, diagnostics = [], completion = undefined) {
    if (journal === undefined) return
    journal.status = status
    journal.completion = result.error === undefined
      ? {
          kind: 'return',
          hasValue: completion?.hasValue === true,
          ...(completion?.hasValue === true ? { value: completion.value } : {}),
        }
      : { kind: 'throw', error: { kind: result.error.kind, message: result.error.message } }
    if (volatileReason !== undefined) journal.volatileReason = volatileReason
    if (diagnostics.length > 0) journal.diagnostics.push(...diagnostics)
    if (status === 'volatile') {
      journal.operations = journal.operations.filter(operation => operation.action !== 'save')
    }
    if (status === 'discarded' || status === 'noop') {
      journal.calls.length = 0
      journal.operations.length = 0
    }
  }

  rollbackToDurable() {
    this.durability = durabilityState()
    this.replayed = false
    this.bindingCatalog = new BindingCatalog()
  }

  settleCell(active, result, terminate = false) {
    /* c8 ignore next */
    if (this.active !== active) return
    const { request, journal, replay, prepared, worker } = active
    clearInterval(active.computeTimer)
    clearTimeout(active.wallTimer)
    request.signal?.removeEventListener('abort', active.onAbort)
    if (active.rewrites !== undefined && active.rewrites.length > 0) {
      result = { ...result, rewrites: active.rewrites }
    }
    if (journal !== undefined && replay === undefined) {
      if (terminate) {
        const volatileReason = active.pendingBindings.values().next().value ?? active.durability.reason
        this.completeJournal(journal, 'discarded', result, volatileReason, active.diagnostics)
        this.rollbackToDurable()
        if (volatileReason !== undefined) {
          this.durability = transitionDurability(this.durability, {
            type: 'volatile',
            reason: volatileReason,
          })
        }
      } else {
        const status = active.durability.status
        this.completeJournal(
          journal, status, result, active.durability.reason, active.diagnostics, active.completion,
        )
        this.tentatives.set(journal, {
          callSeq: request.callSeq,
          program: request.program,
          bindingCatalog: active.appliedBindingCatalog
            ?? active.priorBindingCatalog.advance(prepared),
          worker,
        })
      }
    }
    if (replay !== undefined && !terminate) {
      this.bindingCatalog = active.appliedBindingCatalog
        ?? active.priorBindingCatalog.advance(prepared)
    }
    this.active = undefined
    if (terminate) void this.client.reset(worker)
    active.finish(result)
  }

  finalizeJournal(journal, confirmed) {
    const tentative = this.tentatives.get(journal)
    if (tentative === undefined) return
    this.tentatives.delete(journal)
    if (!confirmed) {
      if (journal.status === 'durable' || journal.status === 'volatile') {
        const reason = journal.volatileReason ?? 'run_code journal was not preserved in the final tool result'
        this.durability = transitionDurability(this.durability, {
          type: 'volatile',
          reason,
        })
        this.bindingCatalog = tentative.bindingCatalog
      }
      return
    }
    if (journal.status === 'durable') {
      const normalized = normalizeJournal(journal)
      const node = Object.freeze({
        code: tentative.program,
        journal: normalized,
        ...(tentative.callSeq === undefined ? {} : { callSeq: tentative.callSeq }),
        parent: this.history.head,
      })
      const index = this.history.nodes.push(node) - 1
      this.history.head = index
      this.bindingCatalog = tentative.bindingCatalog
      this.finishStateOperations(journal.operations, index, tentative.worker)
      return
    }
    if (journal.status === 'volatile') {
      this.durability = transitionDurability(this.durability, {
        type: 'volatile',
        reason: journal.volatileReason,
      })
      this.bindingCatalog = tentative.bindingCatalog
      this.finishStateOperations(journal.operations, undefined, tentative.worker)
    }
  }

  finishStateOperations(operations, index, worker) {
    const transition = reduceStateOperations(this.history, operations, index)
    this.history.head = transition.head
    this.history.checkpoints = transition.checkpoints
    if (transition.restored) {
      this.rollbackToDurable()
      void this.client.reset(worker)
    }
  }

  async dispose() {
    this.disposed = true
    const worker = this.client.worker
    if (worker !== undefined) {
      /* c8 ignore next */
      this.active?.resolve({ logs: [], error: { kind: 'abort', message: 'session kernel disposed' } }, true)
    }
    await this.client.dispose()
    await this.tail
  }
}

function sessionOf(sessionContext) {
  if (typeof sessionContext !== 'object' || sessionContext === null) {
    return {
      id: String(sessionContext),
      session: undefined,
      callId: undefined,
      persistedCallSeq: undefined,
      cwd: undefined,
    }
  }
  const session = sessionContext.session
  return {
    id: String(sessionContext.id),
    session,
    callId: sessionContext.callId,
    persistedCallSeq: sessionContext.persistedCallSeq,
    cwd: typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined,
  }
}

export class SessionRuntime {
  constructor(config = {}, options = {}) {
    this.config = resolveConfig(config)
    this.kernels = new Map()
    this.pendingNoops = new Map()
    this.disposed = false
    this.withInitiator = typeof options.withInitiator === 'function' ? options.withInitiator : undefined
  }

  async run(sessionContext, request) {
    if (this.disposed) return Promise.resolve({ logs: [], error: { kind: 'abort', message: 'PTC runtime disposed' } })
    let bindingDescriptors
    try {
      bindingDescriptors = normalizeBindingDescriptors(request?.bindings)
    } catch (error) {
      return { logs: [], error: { kind: 'exception', message: messageOf(error) } }
    }
    request = { ...request, bindings: bindingDescriptors.namespaces, bindingDescriptors }
    const { id: sessionId, session, callId, persistedCallSeq, cwd } = sessionOf(sessionContext)
    let callSeq
    try {
      if (persistedCallSeq !== undefined
        && (!Number.isSafeInteger(persistedCallSeq) || persistedCallSeq < 0)) {
        throw new Error('persisted tool call sequence must be a non-negative safe integer')
      }
      callSeq = this.config.durableReplay
        ? persistedCallSeq ?? liveToolCallSeq(session, callId, 'run_code')
        : undefined
    } catch (error) {
      return { logs: [], error: { kind: 'recovery', message: `cannot identify current run_code call in session log: ${messageOf(error)}` } }
    }
    let kernel = this.kernels.get(sessionId)
    if (kernel === undefined) {
      let history
      try {
        history = this.config.durableReplay
          ? recoverJournal(session, callSeq)
          : emptyHistory()
      } catch (error) {
        return { logs: [], error: { kind: 'recovery', message: `cannot reconstruct REPL from session log: ${messageOf(error)}` } }
      }
      kernel = new SessionKernel({
        config: this.config,
        history,
        cwd,
        session,
        withInitiator: this.withInitiator,
      })
      this.kernels.set(sessionId, kernel)
    }
    const journal = createJournal(
      /* c8 ignore next */
      this.pendingNoops.get(sessionId) ?? [],
      this.config.looseTopLevelRedeclarations ? 'loose' : 'strict',
      rewritePolicy(this.config),
    )
    const result = await kernel.run({ ...request, journal, callSeq })
    if (typeof sessionContext === 'object' && sessionContext !== null) {
      sessionContext.journal = journal
      sessionContext.kernel = kernel
      if (result.rewrites !== undefined) sessionContext.rewrites = result.rewrites
    }
    const { journal: _ignored, ...publicResult } = result
    return publicResult
  }

  noteNoop(sessionId, session, callId) {
    const callSeq = liveToolCallSeq(session, String(callId), 'run_code')
    if (callSeq === undefined) return
    const id = String(sessionId)
    let calls = this.pendingNoops.get(id)
    if (calls === undefined) {
      calls = new Set()
      this.pendingNoops.set(id, calls)
    }
    calls.add(callSeq)
  }

  finalize(sessionContext, confirmed) {
    const journal = sessionContext?.journal
    const kernel = sessionContext?.kernel
    if (journal === undefined || kernel === undefined) return
    kernel.finalizeJournal(journal, confirmed)
    if (!confirmed) return
    const noops = this.pendingNoops.get(String(sessionContext.id))
    if (noops === undefined) return
    for (const callSeq of journal.confirms ?? []) noops.delete(callSeq)
    if (noops.size === 0) this.pendingNoops.delete(String(sessionContext.id))
  }

  async disposeSession(sessionId) {
    const id = String(sessionId)
    const kernel = this.kernels.get(id)
    this.pendingNoops.delete(id)
    if (kernel === undefined) return
    this.kernels.delete(id)
    await kernel.dispose()
  }

  async dispose() {
    this.disposed = true
    const kernels = [...this.kernels.values()]
    this.kernels.clear()
    await Promise.all(kernels.map(kernel => kernel.dispose()))
  }
}
