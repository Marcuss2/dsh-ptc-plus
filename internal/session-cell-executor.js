import {
  decodeValue,
  encodeValue,
  normalizeValueWire,
  projectValueWire,
  valueWiresEqual,
} from './value-wire.js'
import { diagnostic, renderDiagnostic } from './diagnostic.js'
import {
  firstLine,
  limitLogs,
  markBindingFailure,
  messageOf,
  oneLineMessage,
  safeProperty,
} from './failure-reporting.js'
import { assertStateName } from './session-journal.js'
import { PreflightError, prepareProgram } from './cell-analysis.js'
import { ModuleRewriteError } from './cell-rewriter.js'
import { mapSourcePosition } from './source-position-map.js'
import { durabilityState, transitionDurability } from './session-state.js'

function hostCause(error) {
  const candidate = safeProperty(error, 'diagnostic') ?? safeProperty(error, 'cause') ?? error
  const candidateMessage = safeProperty(candidate, 'message')
  const message = firstLine(candidateMessage, oneLineMessage(error))
  const candidateCode = safeProperty(candidate, 'code')
  const errorCode = safeProperty(error, 'code')
  const code = firstLine(candidateCode, firstLine(errorCode, undefined))
  return { ...(code === undefined ? {} : { code }), message }
}

function isBindingReferenceError(error) {
  return error.name === 'ReferenceError'
    && (/\bis not defined\b/.test(error.message)
      || /Cannot access ['"][^'"]+['"] before initialization/.test(error.message))
}

function parseDiagnostic(error, source) {
  const cellPosition = error instanceof ModuleRewriteError ? error.cellPosition : undefined
  const line = Number.isSafeInteger(cellPosition?.line)
    ? cellPosition.line
    : Number.isSafeInteger(error?.loc?.line) ? error.loc.line - 1 : undefined
  const column = Number.isSafeInteger(cellPosition?.column)
    ? cellPosition.column
    : Number.isSafeInteger(error?.loc?.column) ? error.loc.column + 1 : undefined
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

function exceptionDiagnostic({ error, cause, position, declared }) {
  const message = firstLine(error.message, 'Unknown exception')
  const rawName = typeof error.name === 'string' && error.name.length > 0
    ? error.name
    /* c8 ignore next */
    : typeof error.kind === 'string' && error.kind.length > 0 ? error.kind : 'Error'
  const name = firstLine(rawName, 'Error')
  const source = position === undefined || !Number.isSafeInteger(position.line) || position.line < 1
    || !Number.isSafeInteger(position.column) || position.column < 1
    ? undefined
    : { cell: 'current', start: { line: position.line, column: position.column } }
  return diagnostic({
    code: 'PTC-X001',
    severity: 'error',
    phase: 'execute',
    message: `uncaught ${name}: ${message}`,
    stateEffect: 'partially-applied',
    ...(cause === undefined ? {} : { cause }),
    ...(source === undefined ? {} : { source }),
    help: [
      'inspect existing bindings and retry only the failing expression',
      ...(declared.size === 0
        ? []
        : ['use fresh names for one-off top-level bindings after partial execution; later declarations may be uninitialized']),
    ],
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

/** Owns one cell's evaluator lifecycle and the worker-to-host binding bridge. */
export class SessionCellExecutor {
  constructor(kernel) {
    this.kernel = kernel
  }

  async executeCell(request, replayRecord = undefined) {
    const kernel = this.kernel
    if (kernel.disposed) {
      const result = { logs: [], error: { kind: 'abort', message: 'session kernel disposed' } }
      kernel.completeJournal(request.journal, 'noop', result)
      return result
    }
    if (request.signal?.aborted) {
      const result = { logs: [], error: { kind: 'abort', message: String(request.signal.reason) } }
      kernel.completeJournal(request.journal, 'noop', result)
      return result
    }

    let prepared
    const catalog = kernel.bindingCatalog.inputs()
    let looseTopLevelRedeclarations
    try {
      looseTopLevelRedeclarations = replayRecord === undefined
        ? kernel.config.looseTopLevelRedeclarations
        : replayRecord.bindingMode === 'loose'
      prepared = prepareProgram(
        request.program,
        catalog.knownBindings,
        looseTopLevelRedeclarations,
        request.bindingDescriptors.reservedNames,
        replayRecord === undefined ? kernel.rewritePolicy() : replayRecord.rewritePolicy,
        catalog.importBindings,
        catalog.importNamespaces,
      )
    } catch (error) {
      const result = { logs: [], error: { kind: 'exception', message: messageOf(error) } }
      const failure = error instanceof PreflightError ? preflightDiagnostic(error) : parseDiagnostic(error, request.program)
      result.error.message = renderDiagnostic(failure, request.program)
      kernel.completeJournal(request.journal, 'noop', result, undefined, [failure])
      return result
    }
    if (prepared.collisions.length > 0) {
      const result = {
        logs: [],
        error: markBindingFailure({ kind: 'exception', message: 'top-level binding collision' }),
      }
      const failure = collisionDiagnostic(prepared.collisions)
      result.error.message = renderDiagnostic(failure, request.program)
      kernel.completeJournal(request.journal, 'noop', result, undefined, [failure])
      return result
    }

    let worker
    try {
      worker = await kernel.client.ensure()
    } catch (error) {
      const result = { logs: [], error: { kind: 'worker-exit', message: messageOf(error) } }
      kernel.completeJournal(request.journal, 'discarded', result)
      kernel.rollbackToDurable()
      return result
    }
    if (request.signal?.aborted) {
      const result = { logs: [], error: { kind: 'abort', message: String(request.signal.reason) } }
      kernel.completeJournal(request.journal, 'discarded', result)
      kernel.rollbackToDurable()
      void kernel.client.reset(worker)
      return result
    }

    const journal = request.journal
    const desiredDurability = replayRecord === undefined
      ? !kernel.config.durableReplay || kernel.durability.status === 'volatile' ? 'volatile' : prepared.durability
      : 'durable'
    const bindings = this.withControlBinding(request.bindingDescriptors, journal, replayRecord)
    const id = ++kernel.sequence
    return new Promise((resolve) => {
      const started = worker.performance.eventLoopUtilization()
      const active = {
        id,
        request: { ...request, bindings: bindings.namespaces },
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
        appliedBindingCatalog: undefined,
        completion: undefined,
        durability: durabilityState({
          status: desiredDurability,
          reason: kernel.durability.status === 'volatile'
            ? kernel.durability.reason
            : !kernel.config.durableReplay
              ? 'durable replay disabled by configuration'
              : prepared.reason || undefined,
        }),
        control: { names: new Set(kernel.history.checkpoints.keys()) },
        rewrites: prepared.rewrites,
        prepared,
        priorBindingCatalog: kernel.bindingCatalog,
        worker,
      }
      active.resolve = (result, terminate = false) => kernel.settleCell(active, result, terminate)
      active.onAbort = () => active.resolve(
        { logs: [], error: { kind: 'abort', message: String(request.signal?.reason) } },
        true,
      )
      active.computeTimer = setInterval(() => {
        if (worker.performance.eventLoopUtilization(started).active > kernel.config.computeMs) {
          active.resolve({ logs: [], error: { kind: 'timeout', message: `compute budget exhausted (${kernel.config.computeMs}ms busy); split the work into smaller cells` } }, true)
        }
      }, Math.min(100, kernel.config.computeMs))
      active.wallTimer = setTimeout(() => {
        active.resolve({ logs: [], error: { kind: 'timeout', message: `wall-clock ceiling reached (${kernel.config.maxWallMs}ms); split long-running work into smaller cells` } }, true)
      }, kernel.config.maxWallMs)
      kernel.active = active
      request.signal?.addEventListener('abort', active.onAbort, { once: true })
      if (request.signal?.aborted) {
        active.onAbort()
        return
      }
      try {
        kernel.client.post({
          type: 'run', id, program: prepared.code, namespaces: bindings.workerDescriptors,
          moduleLoads: prepared.moduleLoads,
          returnSignal: prepared.returnSignal,
          maxOutputBytes: kernel.config.maxOutputBytes,
          valueLimits: kernel.valueLimits(),
          durability: desiredDurability,
        })
      } catch (error) {
        active.resolve({ logs: [], error: { kind: 'worker-exit', message: messageOf(error) } }, true)
      }
    })
  }

  withControlBinding(bindingDescriptors, journal, replayRecord) {
    if (replayRecord === undefined && journal === undefined) return bindingDescriptors
    const control = async args => {
      const parsed = stateArguments(args)
      if (replayRecord !== undefined) return { action: parsed.action, ...(parsed.name === undefined ? {} : { name: parsed.name }) }
      return this.controlState(parsed)
    }
    const namespace = Object.freeze({
      global: 'repl',
      functions: Object.freeze({ state: control }),
      members: Object.freeze(['state']),
    })
    return Object.freeze({
      namespaces: Object.freeze([...bindingDescriptors.namespaces, namespace]),
      reservedNames: bindingDescriptors.reservedNames,
      workerDescriptors: Object.freeze([
        ...bindingDescriptors.workerDescriptors,
        Object.freeze({ global: 'repl', members: namespace.members }),
      ]),
    })
  }

  controlState(parsed) {
    const kernel = this.kernel
    const active = kernel.active
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

  onMessage(message) {
    const kernel = this.kernel
    if (message === null || typeof message !== 'object') return
    if (message.type === 'volatile' && kernel.active?.id === message.id) {
      kernel.active.durability = transitionDurability(kernel.active.durability, {
        type: 'volatile',
        reason: typeof message.reason === 'string' ? message.reason : undefined,
      })
      return
    }
    if (message.type === 'call') {
      void this.invokeBinding(message)
      return
    }
    if (message.type === 'output-limit' && kernel.active?.id === message.id) {
      /* c8 ignore next */
      const logs = Array.isArray(message.logs) && message.logs.every(log => typeof log === 'string') ? message.logs : []
      kernel.active.resolve({
        logs: limitLogs(logs),
        error: { kind: 'output-limit', message: `output exceeded ${kernel.config.maxOutputBytes} bytes; reduce the returned value or keep it in a REPL binding` },
      }, true)
      return
    }
    if (message.type !== 'done' || kernel.active?.id !== message.id) return

    const active = kernel.active
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
    if (bytes > kernel.config.maxOutputBytes) {
      active.resolve({
        logs: limitLogs(logs),
        error: { kind: 'output-limit', message: `output exceeded ${kernel.config.maxOutputBytes} bytes; reduce the returned value or keep it in a REPL binding` },
      }, true)
      return
    }
    if (typeof message.error === 'string') {
      const rawError = {
        kind: 'exception',
        name: typeof message.errorName === 'string' ? message.errorName : 'Error',
        message: message.error,
      }
      const actualFailure = exceptionDiagnostic({
        error: rawError,
        cause: message.cause,
        position: message.moduleLoadFailed === true
          ? message.position
          : mapSourcePosition(
              message.position,
              active.prepared.code,
              active.request.program,
              active.prepared.sourceMap,
            ),
        declared: message.moduleLoadFailed === true ? new Set() : active.prepared.declared,
      })
      active.appliedBindingCatalog = message.moduleLoadFailed === true
        ? active.priorBindingCatalog
        : active.priorBindingCatalog.advance(active.prepared)
      const recordedFailure = active.replay?.diagnostics?.find(item => item.code === 'PTC-X001')
      const failure = recordedFailure?.message === actualFailure.message ? recordedFailure : actualFailure
      const error = {
        kind: 'exception',
        message: renderDiagnostic(failure, active.request.program),
      }
      if (isBindingReferenceError(rawError)) markBindingFailure(error)
      active.diagnostics.push(failure)
      active.resolve({ logs, error })
      return
    }
    if (typeof message.invalidOutput === 'string') {
      const failure = invalidOutputDiagnostic(message.invalidOutput)
      const error = { kind: 'invalid-output', message: renderDiagnostic(failure, active.request.program) }
      active.diagnostics.push(failure)
      active.resolve({ logs, error })
      return
    }
    try {
      if (typeof message.hasValue !== 'boolean'
        || (message.hasValue ? message.value === undefined : message.value !== undefined)) {
        throw new TypeError('invalid PTC completion envelope')
      }
      const value = message.hasValue ? normalizeValueWire(message.value, kernel.valueLimits()) : undefined
      active.completion = {
        hasValue: message.hasValue,
        ...(message.hasValue ? { value } : {}),
      }
      active.appliedBindingCatalog = active.priorBindingCatalog.advance(active.prepared)
      if (active.replay?.completion?.kind === 'return'
        && (active.replay.completion.hasValue !== message.hasValue
          || (message.hasValue && !valueWiresEqual(active.replay.completion.value, value, kernel.valueLimits())))) {
        active.resolve({ logs, error: { kind: 'recovery', message: 'cell replay produced a different completion value' } }, true)
        return
      }
      active.resolve({
        logs,
        ...(message.hasValue ? { value: projectValueWire(value, kernel.valueLimits()) } : {}),
      })
    } catch (error) {
      const failure = invalidOutputDiagnostic(messageOf(error))
      const invalid = { kind: 'invalid-output', message: renderDiagnostic(failure, active.request.program) }
      active.diagnostics.push(failure)
      active.resolve({ logs, error: invalid })
    }
  }

  async invokeBinding(message) {
    const kernel = this.kernel
    const active = kernel.active
    if (active?.worker !== kernel.client.worker || active?.id !== message.runId) {
      kernel.client.port?.postMessage({ type: 'reply', runId: message.runId, id: message.id, ok: false, error: 'PTC execution lease expired' })
      return
    }
    const namespace = active.request.bindings.find(binding => binding.global === message.global)
    const binding = namespace?.functions?.[message.member]
    if (typeof binding !== 'function') {
      kernel.client.post({ type: 'reply', runId: message.runId, id: message.id, ok: false, error: `unknown binding ${message.global}.${message.member}` })
      return
    }
    let argsWire
    let args
    try {
      argsWire = normalizeValueWire(message.args, kernel.valueLimits())
      args = decodeValue(argsWire, kernel.valueLimits())
    } catch (error) {
      kernel.client.post({ type: 'reply', runId: message.runId, id: message.id, ok: false, error: messageOf(error) })
      return
    }
    const recorded = active.replay?.calls?.[active.replayIndex]
    if (active.replay !== undefined) {
      active.replayIndex += 1
      if (recorded === undefined || recorded.global !== message.global || recorded.member !== message.member
        || !valueWiresEqual(recorded.args, argsWire, kernel.valueLimits())) {
        kernel.client.post({ type: 'reply', runId: message.runId, id: message.id, ok: false, error: 'session log replay diverged at a host binding call' })
        return
      }
      const pending = { message, recorded }
      active.replayPending.set(recorded.settle, pending)
      this.flushReplayReplies(active)
      return
    }
    /* c8 ignore next */
    const call = active.journal === undefined
      ? undefined
      : { global: message.global, member: message.member, args: argsWire }
    if (call !== undefined) active.journal.calls.push(call)
    active.pendingBindings.set(message.id, `${message.global}.${message.member}`)
    try {
      // Restore the initiator boundary lost across the worker callback.
      const agent = active.request.executionToken?.agent
      const invoke = () => binding(args)
      const value = kernel.withInitiator === undefined || agent === undefined
        ? await invoke()
        : await kernel.withInitiator(agent, invoke)
      const valueWire = encodeValue(value, kernel.valueLimits())
      if (call !== undefined) {
        call.ok = true
        call.value = valueWire
        call.settle = active.settlementSequence++
      }
      if (active.worker === kernel.client.worker) {
        kernel.client.post({ type: 'reply', runId: message.runId, id: message.id, ok: true, value: valueWire })
      }
    } catch (error) {
      const cause = hostCause(error)
      if (call !== undefined) {
        call.ok = false
        call.error = messageOf(error)
        call.settle = active.settlementSequence++
      }
      if (active.worker === kernel.client.worker) {
        kernel.client.post({
          type: 'reply', runId: message.runId, id: message.id, ok: false,
          error: messageOf(error), cause,
        })
      }
    } finally {
      active.pendingBindings.delete(message.id)
    }
  }

  flushReplayReplies(active) {
    const kernel = this.kernel
    while (active.worker === kernel.client.worker) {
      const pending = active.replayPending.get(active.replayNextSettle)
      if (pending === undefined) return
      if (pending.waiting === true && pending.response === undefined) return
      active.replayPending.delete(active.replayNextSettle)
      active.replayNextSettle += 1
      const { message, recorded } = pending
      const response = pending.response
      const selected = response ?? recorded
      kernel.client.post(selected.ok
        ? { type: 'reply', runId: message.runId, id: message.id, ok: true, value: selected.value }
        : { type: 'reply', runId: message.runId, id: message.id, ok: false, error: selected.error })
    }
  }
}
