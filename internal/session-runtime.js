import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  decodeValue,
  encodeValue,
  normalizeValueWire,
  projectValueWire,
  valueWiresEqual,
} from './value-wire.js'
import { diagnostic, renderDiagnostic } from './diagnostic.js'
import { assertStateName, createJournal, normalizeJournal, pathToHead, recoverJournal } from './session-journal.js'
import { PreflightError, describeBindings, prepareProgram, reservedBindingNames } from './cell-analysis.js'

const WORKER_URL = new URL('./kernel-worker.js', import.meta.url)
const STRIP_PREFIX = 'async function __ptc_cell__(){\n'
const STRIP_SUFFIX = '\n}'
const RETURN_SIGNAL = '__dsh_ptc_return_signal_7f3a__'
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
})
const MAX_TIMER_DELAY_MS = 2_147_483_647
const DURABLE_IMPORTS = new Set([
  'node:assert',
  'node:buffer',
  'node:querystring',
  'node:string_decoder',
  'node:stream',
  'node:util',
  'node:url',
  'node:zlib',
])
const AMBIENT_GLOBALS = new Set([
  'Date', 'performance', 'fetch', 'WebSocket', 'crypto', 'Intl',
  'setTimeout', 'setInterval', 'setImmediate', 'eval', 'Function', 'require',
])
const FORBIDDEN_IMPORTS = new Set(['node:worker_threads', 'worker_threads', 'node:cluster', 'cluster'])


function safeProperty(value, key) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined
  try {
    return value[key]
  } catch {
    return undefined
  }
}

function messageOf(error) {
  const message = safeProperty(error, 'message')
  if (typeof message === 'string') return message
  try {
    return String(error)
  } catch {
    return 'Unprintable error'
  }
}

function firstLine(value, fallback) {
  if (typeof value !== 'string') return fallback
  const line = value.split(/[\r\n]/, 1)[0]
  return line.length > 0 ? line : fallback
}

function oneLineMessage(error) {
  return firstLine(messageOf(error), 'Unknown error').replace(/\s+\(\d+:\d+\)$/, '')
}

function hostCause(error) {
  const candidate = safeProperty(error, 'diagnostic') ?? safeProperty(error, 'cause') ?? error
  const candidateMessage = safeProperty(candidate, 'message')
  const message = firstLine(candidateMessage, oneLineMessage(error))
  const candidateCode = safeProperty(candidate, 'code')
  const errorCode = safeProperty(error, 'code')
  const code = firstLine(candidateCode, firstLine(errorCode, undefined))
  return { ...(code === undefined ? {} : { code }), message }
}

function recoveryDiagnostic(count) {
  return diagnostic({
    code: 'PTC-R002',
    severity: 'warning',
    phase: 'recover',
    message: `Restored the durable head and skipped ${count} volatile or unconfirmed cell(s) from history; their source remains in the session log.`,
    stateEffect: 'rolled-back',
    help: [
      'continue from the restored bindings',
      'do not reference values created only in the skipped suffix',
    ],
  })
}

function parseDiagnostic(error, source) {
  const sourceLines = typeof source === 'string' ? source.split(/\r?\n/) : []
  let line = Number.isSafeInteger(error?.loc?.line) ? error.loc.line - 1 : undefined
  let column = Number.isSafeInteger(error?.loc?.column) ? error.loc.column + 1 : undefined
  if (line !== undefined && line > sourceLines.length && sourceLines.length > 0) {
    line = sourceLines.length
    column = sourceLines[sourceLines.length - 1].length + 1
  }
  return diagnostic({
    code: 'PTC-C001',
    severity: 'error',
    phase: 'parse',
    message: `cell could not be parsed: ${oneLineMessage(error)}`,
    stateEffect: 'unchanged',
    ...(line !== undefined && line >= 1 && column !== undefined ? {
      source: { cell: 'current', start: { line, column } },
    } : {}),
    help: ['repair the reported syntax and retry only this cell'],
  })
}

function preflightDiagnostic(error) {
  return diagnostic({
    code: 'PTC-C002',
    severity: 'error',
    phase: 'preflight',
    message: oneLineMessage(error),
    stateEffect: 'unchanged',
    /* c8 ignore next */
    ...(error.span === undefined ? {} : {
      source: {
        cell: 'current',
        start: { line: error.span.line, column: error.span.column },
        /* c8 ignore next */
        ...(error.span.end === undefined ? {} : { end: error.span.end }),
      },
    }),
    help: ['remove the kernel-control import and use the provided REPL or tools bindings'],
  })
}

function collisionDiagnostic(collisions) {
  const names = [...new Set(collisions.map(item => item.name))]
  const first = collisions[0]
  return diagnostic({
    code: 'PTC-N001',
    severity: 'error',
    phase: 'preflight',
    message: `top-level bindings already exist: ${names.join(', ')}. This cell was not executed; the REPL state is unchanged.`,
    stateEffect: 'unchanged',
    source: { cell: 'current', start: first.start, end: first.end },
    help: [
      'reuse the existing bindings',
      'place one-off declarations inside a block',
    ],
  })
}

function exceptionDiagnostic(error, cause = undefined) {
  const message = firstLine(error.message, 'Unknown exception')
  const rawName = typeof error.name === 'string' && error.name.length > 0
    ? error.name
    /* c8 ignore next */
    : typeof error.kind === 'string' && error.kind.length > 0 ? error.kind : 'Error'
  const name = firstLine(rawName, 'Error')
  return diagnostic({
    code: 'PTC-X001',
    severity: 'error',
    phase: 'execute',
    message: `uncaught ${name}: ${message}`,
    stateEffect: 'partially-applied',
    ...(cause === undefined ? {} : { cause }),
    help: ['inspect existing bindings and retry only the failing expression'],
  })
}

function invalidOutputDiagnostic(detail) {
  return diagnostic({
    code: 'PTC-O001',
    severity: 'error',
    phase: 'execute',
    message: `cell result could not cross the PTC Value V1 boundary: ${firstLine(detail, 'unknown output encoding failure')}`,
    stateEffect: 'partially-applied',
    help: [
      'return a PTC Value V1 value or keep the live value in a REPL binding',
      'reduce the returned graph when it exceeds the configured value budget',
    ],
  })
}

function stateArguments(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('repl.state expects an object')
  }
  const action = value.action
  if (!['list', 'save', 'restore', 'delete'].includes(action)) {
    throw new TypeError('repl.state action must be list, save, restore, or delete')
  }
  if (action === 'save' || action === 'delete' || (action === 'restore' && value.name !== undefined)) {
    assertStateName(value.name)
  }
  return { action, ...(value.name === undefined ? {} : { name: value.name }) }
}


function resolveConfig(config) {
  const resolved = { ...DEFAULTS, ...config }
  for (const key of [
    'computeMs', 'maxWallMs', 'maxOutputBytes', 'maxOldGenerationSizeMb',
    'maxValueNodes', 'maxValueEdges', 'maxValueArrayLength', 'maxValueBigIntDigits',
  ]) {
    const value = resolved[key]
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`ptc-plus: ${key} must be a positive safe integer`)
    }
  }
  if (resolved.maxWallMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`ptc-plus: maxWallMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  if (typeof resolved.looseTopLevelRedeclarations !== 'boolean') {
    throw new TypeError('ptc-plus: looseTopLevelRedeclarations must be a boolean')
  }
  if (typeof resolved.durableReplay !== 'boolean') {
    throw new TypeError('ptc-plus: durableReplay must be a boolean')
  }
  return resolved
}

function durabilityState(overrides = {}) {
  return Object.freeze({
    status: 'durable',
    reason: undefined,
    ...overrides,
  })
}

function transitionDurability(state, transition) {
  if (transition.type === 'volatile') {
    return durabilityState({
      ...state,
      status: 'volatile',
      reason: state.reason ?? transition.reason,
    })
  }
}

class SessionKernel {
  constructor(config, history, cwd) {
    this.config = config
    this.history = history
    this.cwd = cwd
    this.checkpoints = history.checkpoints
    this.durableHead = history.head
    this.durability = durabilityState()
    this.knownBindings = new Set()
    this.replayed = false
    this.recoveryNotice = history.volatileSuffix.length === 0
      ? undefined
      : recoveryDiagnostic(history.volatileSuffix.length)
    this.worker = undefined
    this.workerReady = undefined
    this.port = undefined
    this.active = undefined
    this.sequence = 0
    this.tail = Promise.resolve()
    this.terminations = new Set()
    this.tentatives = new WeakMap()
    this.scratchReady = undefined
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

  run(request) {
    const execute = () => this.execute(request)
    const result = this.tail.then(execute, execute)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  async execute(request) {
    if (!this.replayed) {
      try {
        await this.replayHistory(request)
        this.replayed = true
      } catch (error) {
        const result = { logs: [], error: { kind: 'recovery', message: `cannot reconstruct REPL from session log: ${messageOf(error)}` } }
        this.completeJournal(request.journal, 'noop', result)
        return result
      }
    }
    const notices = []
    if (this.recoveryNotice !== undefined) {
      notices.push(this.recoveryNotice)
      this.recoveryNotice = undefined
    }
    const leadingDiagnostics = notices.splice(0)
    if (request.journal !== undefined) request.journal.diagnostics.push(...leadingDiagnostics)
    const result = await this.executeCell(request)
    if (leadingDiagnostics.length > 0) {
      const rendered = leadingDiagnostics.map(item => renderDiagnostic(item, request.program))
      result.logs = [...rendered, ...result.logs]
    }
    return result
  }

  async replayHistory(request) {
    this.knownBindings = new Set()
    const path = pathToHead({ ...this.history, head: this.durableHead })
    for (const node of path) {
      const result = await this.executeCell({ ...request, program: node.code, journal: undefined }, node.journal)
      const completion = node.journal.completion
      if (result.error !== undefined && !['exception', 'invalid-output'].includes(result.error.kind)) {
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
      const prepared = prepareProgram(
        node.code,
        this.knownBindings,
        node.journal.bindingMode === 'loose',
        reservedBindingNames(request.bindings),
      )
      for (const name of prepared.declared) this.knownBindings.add(name)
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
    this.knownBindings = new Set()
  }

  settleCell(active, result, terminate = false) {
    /* c8 ignore next */
    if (this.active !== active) return
    const { request, journal, replay, prepared, worker } = active
    clearInterval(active.computeTimer)
    clearTimeout(active.wallTimer)
    request.signal?.removeEventListener('abort', active.onAbort)
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
          program: request.program,
          declared: prepared.declared,
          worker,
        })
      }
    }
    this.active = undefined
    if (terminate) void this.resetWorker(worker)
    active.finish(result)
  }

  /** Evaluate one live or journal-replay cell. */
  async executeCell(request, replayRecord = undefined) {
    if (this.disposed) {
      const result = { logs: [], error: { kind: 'abort', message: 'session kernel disposed' } }
      this.completeJournal(request.journal, 'noop', result)
      return result
    }
    if (request.signal?.aborted) {
      const result = { logs: [], error: { kind: 'abort', message: String(request.signal.reason) } }
      this.completeJournal(request.journal, 'noop', result)
      return result
    }

    let prepared
    let looseTopLevelRedeclarations
    try {
      looseTopLevelRedeclarations = replayRecord === undefined
        ? this.config.looseTopLevelRedeclarations
        : replayRecord.bindingMode === 'loose'
      prepared = prepareProgram(
        request.program,
        this.knownBindings,
        looseTopLevelRedeclarations,
        reservedBindingNames(request.bindings),
      )
    } catch (error) {
      const result = { logs: [], error: { kind: 'exception', message: messageOf(error) } }
      const failure = error instanceof PreflightError ? preflightDiagnostic(error) : parseDiagnostic(error, request.program)
      result.error.message = renderDiagnostic(failure, request.program)
      result.logs = [result.error.message]
      this.completeJournal(request.journal, 'noop', result, undefined, [failure])
      return result
    }
    try {
      describeBindings(request.bindings)
    } catch (error) {
      const result = { logs: [], error: { kind: 'exception', message: messageOf(error) } }
      this.completeJournal(request.journal, 'noop', result)
      return result
    }
    if (prepared.collisions.length > 0) {
      const result = { logs: [], error: { kind: 'exception', message: 'top-level binding collision' } }
      const failure = collisionDiagnostic(prepared.collisions)
      result.error.message = renderDiagnostic(failure, request.program)
      result.logs = [result.error.message]
      this.completeJournal(request.journal, 'noop', result, undefined, [failure])
      return result
    }

    let worker
    try {
      worker = await this.ensureWorker()
    } catch (error) {
      const result = { logs: [], error: { kind: 'worker-exit', message: messageOf(error) } }
      this.completeJournal(request.journal, 'discarded', result)
      this.rollbackToDurable()
      return result
    }
    if (request.signal?.aborted) {
      const result = { logs: [], error: { kind: 'abort', message: String(request.signal.reason) } }
      this.completeJournal(request.journal, 'discarded', result)
      this.rollbackToDurable()
      void this.resetWorker(worker)
      return result
    }

    const journal = request.journal
    const desiredDurability = replayRecord === undefined
      ? !this.config.durableReplay || this.durability.status === 'volatile' ? 'volatile' : prepared.durability
      : 'durable'
    const bindings = this.withControlBinding(request.bindings, journal, replayRecord)
    const id = ++this.sequence
    return new Promise((resolve) => {
      const started = worker.performance.eventLoopUtilization()
      const active = {
        id,
        request: { ...request, bindings },
        finish: resolve,
        computeTimer: undefined,
        wallTimer: undefined,
        onAbort: undefined,
        journal,
        replay: replayRecord,
        replayIndex: 0,
        replayNextSettle: 0,
        replayPending: new Map(),
        pendingBindings: new Map(),
        settlementSequence: 0,
        diagnostics: [],
        completion: undefined,
        durability: durabilityState({
          status: desiredDurability,
          reason: this.durability.status === 'volatile'
            ? this.durability.reason
            : !this.config.durableReplay
              ? 'durable replay disabled by configuration'
              : prepared.reason || undefined,
        }),
        control: { names: new Set(this.checkpoints.keys()) },
        prepared,
        worker,
      }
      active.resolve = (result, terminate = false) => this.settleCell(active, result, terminate)
      active.onAbort = () => active.resolve(
        { logs: [], error: { kind: 'abort', message: String(request.signal?.reason) } },
        true,
      )
      active.computeTimer = setInterval(() => {
        if (worker.performance.eventLoopUtilization(started).active > this.config.computeMs) {
          active.resolve({ logs: [], error: { kind: 'timeout', message: `compute budget exhausted (${this.config.computeMs}ms busy)` } }, true)
        }
      }, Math.min(100, this.config.computeMs))
      active.wallTimer = setTimeout(() => {
        active.resolve({ logs: [], error: { kind: 'timeout', message: `wall-clock ceiling reached (${this.config.maxWallMs}ms)` } }, true)
      }, this.config.maxWallMs)
      this.active = active
      request.signal?.addEventListener('abort', active.onAbort, { once: true })
      if (request.signal?.aborted) {
        active.onAbort()
        return
      }
      try {
        const effectiveNamespaces = describeBindings(bindings)
        this.port.postMessage({
          type: 'run', id, program: prepared.code, namespaces: effectiveNamespaces,
          maxOutputBytes: this.config.maxOutputBytes,
          valueLimits: this.valueLimits(),
          durability: desiredDurability,
        })
      } catch (error) {
        active.resolve({ logs: [], error: { kind: 'worker-exit', message: messageOf(error) } }, true)
      }
    })
  }

  withControlBinding(bindings, journal, replayRecord) {
    if (replayRecord === undefined && journal === undefined) return bindings
    const control = async args => {
      const parsed = stateArguments(args)
      /* c8 ignore next */
      if (replayRecord !== undefined) return { action: parsed.action, ...(parsed.name === undefined ? {} : { name: parsed.name }) }
      return this.controlState(parsed)
    }
    return [...bindings, { global: 'repl', functions: { state: control } }]
  }

  controlState(parsed) {
    const active = this.active
    if (active?.control === undefined || active.journal === undefined) {
      throw new Error('REPL state control is unavailable outside a cell')
    }
    const { action, name } = parsed
    if (action === 'list') {
      return {
        names: [...active.control.names].sort(),
        mode: active.durability.status,
        ...(active.durability.reason === undefined ? {} : { volatileReason: active.durability.reason }),
      }
    }
    if (action === 'save') {
      if (active.durability.status === 'volatile') {
        throw new Error('cannot save a durable REPL state from a volatile segment; restore a durable state first')
      }
      active.control.names.add(name)
      active.journal.operations.push({ action, name })
      return { action, name, saved: true }
    }
    if (action === 'delete') {
      active.control.names.delete(name)
      active.journal.operations.push({ action, name })
      return { action, name, deleted: true }
    }
    if (name !== undefined && !active.control.names.has(name)) throw new Error(`REPL state "${name}" does not exist`)
    active.journal.operations.push({ action, ...(name === undefined ? {} : { name }) })
    return { action, ...(name === undefined ? {} : { name }), restored: true }
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
        for (const name of tentative.declared) this.knownBindings.add(name)
      }
      return
    }
    if (journal.status === 'durable') {
      const normalized = normalizeJournal(journal)
      const node = Object.freeze({ code: tentative.program, journal: normalized, parent: this.durableHead })
      const index = this.history.nodes.push(node) - 1
      this.durableHead = index
      this.history.head = index
      for (const name of tentative.declared) this.knownBindings.add(name)
      this.applyConfirmedOperations(journal.operations, index, tentative.worker)
      return
    }
    if (journal.status === 'volatile') {
      this.durability = transitionDurability(this.durability, {
        type: 'volatile',
        reason: journal.volatileReason,
      })
      for (const name of tentative.declared) this.knownBindings.add(name)
      this.applyConfirmedOperations(journal.operations, undefined, tentative.worker)
    }
  }

  applyConfirmedOperations(operations, index, worker) {
    for (const operation of operations) {
      if (operation.action === 'save') {
        if (index !== undefined) this.checkpoints.set(operation.name, index)
      } else if (operation.action === 'delete') {
        this.checkpoints.delete(operation.name)
      } else {
        /* c8 ignore next */
        this.durableHead = operation.name === undefined
          ? index === undefined ? this.durableHead : this.history.nodes[index]?.parent
          : this.checkpoints.get(operation.name)
        this.history.head = this.durableHead
        this.rollbackToDurable()
        void this.resetWorker(worker)
      }
    }
  }

  async ensureWorker() {
    if (this.worker !== undefined) return this.workerReady
    if (this.scratchReady === undefined) {
      const scratchRoot = tmpdir()
      if (!isAbsolute(scratchRoot)) {
        throw new Error(`ptc-plus: host temporary directory must be absolute, got ${JSON.stringify(scratchRoot)}`)
      }
      this.scratchReady = mkdtemp(join(scratchRoot, 'dsh-ptc-plus-'))
    }
    const scratchDirectory = await this.scratchReady
    /* c8 ignore next */
    if (this.disposed) throw new Error('session kernel disposed')
    /* c8 ignore next */
    if (this.worker !== undefined) return this.workerReady
    const worker = new Worker(WORKER_URL, {
      env: {
        TEMP: scratchDirectory,
        TMP: scratchDirectory,
        TMPDIR: scratchDirectory,
      },
      execArgv: [],
      workerData: this.cwd === undefined ? {} : { cwd: this.cwd },
      resourceLimits: { maxOldGenerationSizeMb: this.config.maxOldGenerationSizeMb },
      stdout: true,
      stderr: true,
    })
    worker.stdout.resume()
    worker.stderr.resume()
    worker.on('error', error => this.failWorker(worker, `worker error: ${messageOf(error)}`))
    worker.on('exit', code => this.failWorker(worker, `worker exited with code ${code}`))
    this.worker = worker
    this.workerReady = new Promise((resolve, reject) => {
      const onError = error => reject(error)
      const onExit = code => reject(new Error(`worker exited with code ${code} before opening its private channel`))
      worker.once('error', onError)
      worker.once('exit', onExit)
      worker.once('message', (message) => {
        worker.removeListener('error', onError)
        worker.removeListener('exit', onExit)
        if (message?.type === 'startup-error' && typeof message.error === 'string') {
          reject(new Error(message.error))
          void this.resetWorker(worker)
          return
        }
        if (message?.type !== 'ready' || typeof message.port?.postMessage !== 'function') {
          reject(new Error('kernel worker returned an invalid private channel'))
          void this.resetWorker(worker)
          return
        }
        this.port = message.port
        this.port.on('message', value => this.onMessage(worker, value))
        resolve(worker)
      })
    })
    return this.workerReady
  }

  onMessage(worker, message) {
    if (worker !== this.worker || message === null || typeof message !== 'object') return
    if (message.type === 'volatile' && this.active?.id === message.id) {
      this.active.durability = transitionDurability(this.active.durability, {
        type: 'volatile',
        reason: typeof message.reason === 'string' ? message.reason : undefined,
      })
      return
    }
    if (message.type === 'call') {
      void this.invokeBinding(worker, message)
      return
    }
    if (message.type === 'output-limit' && this.active?.id === message.id) {
      /* c8 ignore next */
      const logs = Array.isArray(message.logs) && message.logs.every(log => typeof log === 'string') ? message.logs : []
      this.active.resolve({ logs, error: { kind: 'output-limit', message: `output exceeded ${this.config.maxOutputBytes} bytes` } }, true)
      return
    }
    if (message.type !== 'done' || this.active?.id !== message.id) return

    const active = this.active
    const logs = Array.isArray(message.logs) && message.logs.every(log => typeof log === 'string') ? message.logs : []
    if (!['durable', 'volatile'].includes(message.durability)) {
      active.resolve({ logs, error: { kind: 'worker-exit', message: 'kernel returned an invalid durability state' } }, true)
      return
    }
    if (message.durability === 'volatile') {
      active.durability = transitionDurability(active.durability, {
        type: 'volatile',
        reason: typeof message.volatileReason === 'string' ? message.volatileReason : undefined,
      })
    }
    if (active.replay !== undefined && active.durability.status !== 'durable') {
      active.resolve({ logs, error: { kind: 'recovery', message: 'durable history requested a volatile capability during replay' } }, true)
      return
    }
    if (active.replay !== undefined
      && (active.replayIndex !== active.replay.calls.length || active.replayPending.size !== 0)) {
      active.resolve({ logs, error: { kind: 'recovery', message: 'session log replay consumed a different host-call transcript' } }, true)
      return
    }
    const bytes = Buffer.byteLength(JSON.stringify({ logs, value: message.value }), 'utf8')
    if (bytes > this.config.maxOutputBytes) {
      active.resolve({ logs: [], error: { kind: 'output-limit', message: `output exceeded ${this.config.maxOutputBytes} bytes` } }, true)
      return
    }
    if (typeof message.error === 'string') {
      const rawError = {
        kind: 'exception',
        name: typeof message.errorName === 'string' ? message.errorName : 'Error',
        message: message.error,
      }
      const actualFailure = exceptionDiagnostic(rawError, message.cause)
      const recordedFailure = active.replay?.diagnostics?.find(item => item.code === 'PTC-X001')
      const failure = recordedFailure?.message === actualFailure.message ? recordedFailure : actualFailure
      const error = { kind: 'exception', message: renderDiagnostic(failure, active.request.program) }
      active.diagnostics.push(failure)
      active.resolve({ logs: [...logs, error.message], error })
      return
    }
    if (typeof message.invalidOutput === 'string') {
      const failure = invalidOutputDiagnostic(message.invalidOutput)
      const error = { kind: 'invalid-output', message: renderDiagnostic(failure, active.request.program) }
      active.diagnostics.push(failure)
      active.resolve({ logs: [...logs, error.message], error })
      return
    }
    try {
      if (typeof message.hasValue !== 'boolean'
        || (message.hasValue ? message.value === undefined : message.value !== undefined)) {
        throw new TypeError('invalid PTC completion envelope')
      }
      const value = message.hasValue ? normalizeValueWire(message.value, this.valueLimits()) : undefined
      active.completion = {
        hasValue: message.hasValue,
        ...(message.hasValue ? { value } : {}),
      }
      if (active.replay?.completion?.kind === 'return'
        && (active.replay.completion.hasValue !== message.hasValue
          || (message.hasValue && !valueWiresEqual(active.replay.completion.value, value, this.valueLimits())))) {
        active.resolve({ logs, error: { kind: 'recovery', message: 'cell replay produced a different completion value' } }, true)
        return
      }
      active.resolve({
        logs,
        ...(message.hasValue ? { value: projectValueWire(value, this.valueLimits()) } : {}),
      })
    } catch (error) {
      const failure = invalidOutputDiagnostic(messageOf(error))
      const invalid = { kind: 'invalid-output', message: renderDiagnostic(failure, active.request.program) }
      active.diagnostics.push(failure)
      active.resolve({ logs: [...logs, invalid.message], error: invalid })
    }
  }

  async invokeBinding(worker, message) {
    const active = this.active
    if (worker !== this.worker || active?.id !== message.runId) {
      this.port?.postMessage({ type: 'reply', runId: message.runId, id: message.id, ok: false, error: 'PTC execution lease expired' })
      return
    }
    const namespace = active.request.bindings.find(binding => binding.global === message.global)
    const binding = namespace?.functions?.[message.member]
    if (typeof binding !== 'function') {
      this.port.postMessage({ type: 'reply', runId: message.runId, id: message.id, ok: false, error: `unknown binding ${message.global}.${message.member}` })
      return
    }
    let argsWire
    let args
    try {
      argsWire = normalizeValueWire(message.args, this.valueLimits())
      args = decodeValue(argsWire, this.valueLimits())
    } catch (error) {
      this.port.postMessage({ type: 'reply', runId: message.runId, id: message.id, ok: false, error: messageOf(error) })
      return
    }
    const recorded = active.replay?.calls?.[active.replayIndex]
    if (active.replay !== undefined) {
      active.replayIndex += 1
      if (recorded === undefined || recorded.global !== message.global || recorded.member !== message.member
        || !valueWiresEqual(recorded.args, argsWire, this.valueLimits())) {
        this.port.postMessage({ type: 'reply', runId: message.runId, id: message.id, ok: false, error: 'session log replay diverged at a host binding call' })
        return
      }
      const pending = { message, recorded }
      active.replayPending.set(recorded.settle, pending)
      this.flushReplayReplies(worker, active)
      return
    }
    /* c8 ignore next */
    const call = active.journal === undefined
      ? undefined
      : { global: message.global, member: message.member, args: argsWire }
    if (call !== undefined) active.journal.calls.push(call)
    active.pendingBindings.set(message.id, `${message.global}.${message.member}`)
    try {
      const value = await binding(args)
      const valueWire = encodeValue(value, this.valueLimits())
      if (call !== undefined) {
        call.ok = true
        call.value = valueWire
        call.settle = active.settlementSequence++
      }
      if (worker === this.worker) {
        this.port.postMessage({ type: 'reply', runId: message.runId, id: message.id, ok: true, value: valueWire })
      }
    } catch (error) {
      const cause = hostCause(error)
      if (call !== undefined) {
        call.ok = false
        call.error = messageOf(error)
        call.settle = active.settlementSequence++
      }
      if (worker === this.worker) {
        this.port.postMessage({
          type: 'reply', runId: message.runId, id: message.id, ok: false,
          error: messageOf(error), cause,
        })
      }
    } finally {
      active.pendingBindings.delete(message.id)
    }
  }

  flushReplayReplies(worker, active) {
    while (worker === this.worker) {
      const pending = active.replayPending.get(active.replayNextSettle)
      if (pending === undefined) return
      if (pending.waiting === true && pending.response === undefined) return
      active.replayPending.delete(active.replayNextSettle)
      active.replayNextSettle += 1
      const { message, recorded } = pending
      const response = pending.response
      const selected = response ?? recorded
      this.port.postMessage(selected.ok
        ? { type: 'reply', runId: message.runId, id: message.id, ok: true, value: selected.value }
        : { type: 'reply', runId: message.runId, id: message.id, ok: false, error: selected.error })
    }
  }

  failWorker(worker, message) {
    if (worker !== this.worker) return
    this.worker = undefined
    this.workerReady = undefined
    this.port?.close()
    this.port = undefined
    this.active?.resolve({ logs: [], error: { kind: 'worker-exit', message } }, true)
  }

  async resetWorker(worker) {
    if (this.worker === worker) {
      this.worker = undefined
      this.workerReady = undefined
      this.port?.close()
      this.port = undefined
    }
    const termination = worker.terminate()
    this.terminations.add(termination)
    try {
      await termination
    } finally {
      this.terminations.delete(termination)
    }
  }

  async dispose() {
    this.disposed = true
    const worker = this.worker
    if (worker !== undefined) {
      /* c8 ignore next */
      this.active?.resolve({ logs: [], error: { kind: 'abort', message: 'session kernel disposed' } }, true)
      await this.resetWorker(worker)
    }
    await Promise.all([...this.terminations])
    await this.tail
    if (this.scratchReady !== undefined) {
      try {
        const scratchDirectory = await this.scratchReady
        await rm(scratchDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      } catch {}
    }
  }
}

export class SessionRuntime {
  constructor(config = {}) {
    this.config = resolveConfig(config)
    this.kernels = new Map()
    this.pendingNoops = new Map()
    this.disposed = false
  }

  async run(sessionContext, request) {
    if (this.disposed) return Promise.resolve({ logs: [], error: { kind: 'abort', message: 'PTC runtime disposed' } })
    const sessionId = typeof sessionContext === 'object' && sessionContext !== null
      ? String(sessionContext.id)
      : String(sessionContext)
    let kernel = this.kernels.get(sessionId)
    if (kernel === undefined) {
      let history
      try {
        history = this.config.durableReplay
          ? recoverJournal(
              typeof sessionContext === 'object' ? sessionContext.session : undefined,
              typeof sessionContext === 'object' ? sessionContext.callId : undefined,
            )
          : { nodes: [], head: undefined, checkpoints: new Map(), volatileSuffix: [], available: true }
      } catch (error) {
        return { logs: [], error: { kind: 'recovery', message: messageOf(error) } }
      }
      const cwd = typeof sessionContext === 'object' && typeof sessionContext.session?.header?.cwd === 'string'
        ? sessionContext.session.header.cwd
        : undefined
      kernel = new SessionKernel(this.config, history, cwd)
      this.kernels.set(sessionId, kernel)
    }
    const journal = createJournal(
      /* c8 ignore next */
      this.pendingNoops.get(sessionId) ?? [],
      this.config.looseTopLevelRedeclarations ? 'loose' : 'strict',
    )
    const result = await kernel.run({ ...request, journal })
    if (typeof sessionContext === 'object' && sessionContext !== null) {
      sessionContext.journal = journal
      sessionContext.kernel = kernel
    }
    const { journal: _ignored, ...publicResult } = result
    return publicResult
  }

  noteNoop(sessionId, callId) {
    const id = String(sessionId)
    let calls = this.pendingNoops.get(id)
    if (calls === undefined) {
      calls = new Set()
      this.pendingNoops.set(id, calls)
    }
    calls.add(String(callId))
  }

  finalize(sessionContext, confirmed) {
    const journal = sessionContext?.journal
    const kernel = sessionContext?.kernel
    if (journal === undefined || kernel === undefined) return
    kernel.finalizeJournal(journal, confirmed)
    if (!confirmed) return
    const noops = this.pendingNoops.get(String(sessionContext.id))
    if (noops === undefined) return
    for (const callId of journal.confirms ?? []) noops.delete(callId)
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
