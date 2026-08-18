import { decodeValue, encodeValue, normalizeValueWire } from './value-wire.js'
import { normalizeDiagnostic } from './diagnostic.js'

export const JOURNAL_KEY = 'dshPtcPlus'
export const JOURNAL_VERSION = 1

const STATUSES = new Set(['durable', 'volatile', 'discarded', 'noop'])
const BINDING_MODES = new Set(['loose', 'strict'])
const JOURNAL_FIELDS = new Set(['version', 'bindingMode', 'status', 'calls', 'operations', 'cordisEffects', 'confirms', 'diagnostics', 'completion', 'volatileReason'])
const CALL_SUCCESS_FIELDS = new Set(['global', 'member', 'args', 'ok', 'value', 'settle'])
const CALL_ERROR_FIELDS = new Set(['global', 'member', 'args', 'ok', 'error', 'settle'])
const OPERATION_FIELDS = new Set(['action', 'name'])
const CORDIS_EFFECT_FIELDS = new Set(['parent', 'member', 'args', 'ok', 'value', 'error'])
const CORDIS_EFFECT_MEMBERS = new Set(['define', 'run', 'stop', 'undefine'])
const RETURN_FIELDS = new Set(['kind', 'hasValue', 'value'])
const THROW_FIELDS = new Set(['kind', 'error'])
const ERROR_FIELDS = new Set(['kind', 'message'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertOwnFields(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)
      || !Object.prototype.propertyIsEnumerable.call(value, key)) {
      throw new Error(`invalid ${label} field ${String(key)}`)
    }
  }
}

function cloneJson(value) {
  if (value === undefined) return undefined
  return decodeValue(encodeValue(value))
}

function validName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
}

function normalizeCalls(value) {
  if (!Array.isArray(value)) throw new Error('invalid dsh-ptc-plus journal calls')
  const calls = value.map((call, index) => {
    if (!isRecord(call) || typeof call.global !== 'string' || typeof call.member !== 'string'
      || !Object.hasOwn(call, 'args') || (call.ok !== true && call.ok !== false)
      || !Number.isSafeInteger(call.settle) || call.settle < 0) {
      throw new Error(`invalid dsh-ptc-plus journal call at index ${index}`)
    }
    assertOwnFields(call, call.ok ? CALL_SUCCESS_FIELDS : CALL_ERROR_FIELDS, `journal call at index ${index}`)
    if (call.ok === true && !Object.hasOwn(call, 'value')) {
      throw new Error(`journal call at index ${index} is missing its value`)
    }
    if (call.ok === false && typeof call.error !== 'string') {
      throw new Error(`journal call at index ${index} is missing its error`)
    }
    return {
      global: call.global,
      member: call.member,
      args: normalizeValueWire(call.args),
      ok: call.ok,
      settle: call.settle,
      ...(call.ok ? { value: normalizeValueWire(call.value) } : { error: call.error }),
    }
  })
  const order = calls.map(call => call.settle).sort((left, right) => left - right)
  if (order.some((settle, index) => settle !== index)) {
    throw new Error('dsh-ptc-plus journal call settlement order is not contiguous')
  }
  return calls
}

function normalizeOperations(value) {
  if (!Array.isArray(value)) throw new Error('invalid dsh-ptc-plus journal operations')
  return value.map((operation, index) => {
    if (!isRecord(operation) || !['save', 'restore', 'delete'].includes(operation.action)
      || ((operation.action !== 'restore' || operation.name !== undefined) && !validName(operation.name))) {
      throw new Error(`invalid dsh-ptc-plus journal operation at index ${index}`)
    }
    assertOwnFields(operation, OPERATION_FIELDS, `journal operation at index ${index}`)
    return { action: operation.action, ...(operation.name === undefined ? {} : { name: operation.name }) }
  })
}

function normalizeCordisEffects(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('invalid dsh-ptc-plus journal Cordis effects')
  return value.map((effect, index) => {
    if (!isRecord(effect) || !Number.isSafeInteger(effect.parent) || effect.parent < 0
      || !CORDIS_EFFECT_MEMBERS.has(effect.member) || (effect.ok !== true && effect.ok !== false)
      || !Object.hasOwn(effect, 'args')) {
      throw new Error(`invalid dsh-ptc-plus journal Cordis effect at index ${index}`)
    }
    assertOwnFields(effect, effect.ok ? new Set([...CORDIS_EFFECT_FIELDS].filter(key => key !== 'error')) : new Set([...CORDIS_EFFECT_FIELDS].filter(key => key !== 'value')), `journal Cordis effect at index ${index}`)
    if (effect.ok === true && !Object.hasOwn(effect, 'value')) {
      throw new Error(`journal Cordis effect at index ${index} is missing its value`)
    }
    if (effect.ok === false && typeof effect.error !== 'string') {
      throw new Error(`journal Cordis effect at index ${index} is missing its error`)
    }
    return {
      parent: effect.parent,
      member: effect.member,
      args: normalizeValueWire(effect.args),
      ok: effect.ok,
      ...(effect.ok ? { value: normalizeValueWire(effect.value) } : { error: effect.error }),
    }
  })
}

function normalizeCompletion(value, required) {
  if (value === undefined && !required) return undefined
  if (!isRecord(value) || !['return', 'throw'].includes(value.kind)) {
    throw new Error('invalid dsh-ptc-plus journal completion')
  }
  if (value.kind === 'return') {
    assertOwnFields(value, RETURN_FIELDS, 'journal return completion')
    if (typeof value.hasValue !== 'boolean'
      || (value.hasValue ? !Object.hasOwn(value, 'value') : Object.hasOwn(value, 'value'))) {
      throw new Error('invalid dsh-ptc-plus journal return value')
    }
    return Object.freeze({
      kind: 'return',
      hasValue: value.hasValue,
      ...(value.hasValue ? { value: normalizeValueWire(value.value) } : {}),
    })
  }
  if (!isRecord(value.error) || typeof value.error.kind !== 'string' || typeof value.error.message !== 'string') {
    throw new Error('invalid dsh-ptc-plus journal throw completion')
  }
  assertOwnFields(value, THROW_FIELDS, 'journal throw completion')
  assertOwnFields(value.error, ERROR_FIELDS, 'journal completion error')
  return Object.freeze({
    kind: 'throw',
    error: Object.freeze({ kind: value.error.kind, message: value.error.message }),
  })
}

function normalizeConfirms(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(callId => typeof callId !== 'string' || callId.length === 0)) {
    throw new Error('invalid dsh-ptc-plus confirmed no-op calls')
  }
  const confirms = [...new Set(value)]
  if (confirms.length !== value.length) throw new Error('duplicate dsh-ptc-plus confirmed no-op call')
  return confirms
}

function normalizeDiagnostics(value) {
  if (!Array.isArray(value)) throw new Error('invalid dsh-ptc-plus journal diagnostics')
  return value.map((diagnostic, index) => {
    try {
      return normalizeDiagnostic(diagnostic)
    } catch (error) {
      throw new Error(`invalid dsh-ptc-plus journal diagnostic at index ${index}: ${error.message}`)
    }
  })
}

/** Validate and detach one journal emitted by the runtime. */
export function normalizeJournal(value) {
  if (!isRecord(value)) throw new Error('invalid dsh-ptc-plus journal')
  if (value.version !== JOURNAL_VERSION || !STATUSES.has(value.status)) {
    throw new Error('invalid dsh-ptc-plus journal')
  }
  assertOwnFields(value, JOURNAL_FIELDS, 'dsh-ptc-plus journal')
  if (!BINDING_MODES.has(value.bindingMode)) throw new Error('invalid dsh-ptc-plus journal binding mode')
  const calls = normalizeCalls(value.calls)
  const operations = normalizeOperations(value.operations)
  const cordisEffects = normalizeCordisEffects(value.cordisEffects)
  if (cordisEffects.some(effect => effect.parent >= calls.length)) {
    throw new Error('dsh-ptc-plus journal Cordis effect refers to a missing parent call')
  }
  if (cordisEffects.some(effect => calls[effect.parent].global !== 'code'
    || calls[effect.parent].member !== 'run')) {
    throw new Error('dsh-ptc-plus journal Cordis effect parent must be code.run')
  }
  const confirms = normalizeConfirms(value.confirms)
  const diagnostics = normalizeDiagnostics(value.diagnostics)
  const completion = normalizeCompletion(value.completion, value.status === 'durable' || value.status === 'volatile')
  if ((value.status === 'discarded' || value.status === 'noop')
    && (calls.length !== 0 || operations.length !== 0 || cordisEffects.length !== 0)) {
    throw new Error(`${value.status} dsh-ptc-plus journal must not contain calls or operations`)
  }
  if (value.volatileReason !== undefined && typeof value.volatileReason !== 'string') {
    throw new Error('invalid dsh-ptc-plus volatile reason')
  }
  return Object.freeze({
    version: JOURNAL_VERSION,
    bindingMode: value.bindingMode,
    status: value.status,
    calls: Object.freeze(calls),
    operations: Object.freeze(operations),
    ...(value.cordisEffects === undefined ? {} : { cordisEffects: Object.freeze(cordisEffects) }),
    confirms: Object.freeze(confirms),
    diagnostics: Object.freeze(diagnostics),
    ...(completion === undefined ? {} : { completion }),
    ...(value.volatileReason === undefined ? {} : { volatileReason: value.volatileReason }),
  })
}

/** Compare journal semantics without recursive traversal of nested JSON. */
export function journalsEqual(left, right) {
  try {
    const leftWire = encodeValue(normalizeJournal(left))
    const rightWire = encodeValue(normalizeJournal(right))
    return JSON.stringify(leftWire) === JSON.stringify(rightWire)
  } catch {
    return false
  }
}

/** Start a mutable journal for one live cell. */
export function createJournal(confirms = [], bindingMode) {
  if (!BINDING_MODES.has(bindingMode)) throw new TypeError('invalid dsh-ptc-plus journal binding mode')
  return { version: JOURNAL_VERSION, bindingMode, calls: [], operations: [], confirms: [...confirms], diagnostics: [] }
}

/** Complete a call which never entered the code runtime. */
export function createNoopJournal(result, bindingMode) {
  if (!BINDING_MODES.has(bindingMode)) throw new TypeError('invalid dsh-ptc-plus journal binding mode')
  return {
    version: JOURNAL_VERSION,
    bindingMode,
    status: 'noop',
    calls: [],
    operations: [],
    confirms: [],
    diagnostics: [],
    completion: result?.isError === true
      ? { kind: 'throw', error: { kind: 'pipeline', message: result.error?.message ?? 'tool call rejected before dispatch' } }
      : { kind: 'return', hasValue: false },
  }
}

function journalFromResult(event) {
  const meta = event.data?.meta
  if (!isRecord(meta) || !Object.hasOwn(meta, JOURNAL_KEY)) return undefined
  return normalizeJournal(meta[JOURNAL_KEY])
}

function sourceForCall(call) {
  try {
    const args = JSON.parse(call.data.arguments)
    return isRecord(args) && typeof args.code === 'string' ? args.code : undefined
  } catch {
    return undefined
  }
}

function applyOperations(state, operations, nodeIndex, allowSave) {
  let restored = false
  for (const operation of operations) {
    if (operation.action === 'save') {
      if (!allowSave || nodeIndex === undefined) throw new Error('volatile journal cannot save a durable REPL state')
      state.checkpoints.set(operation.name, nodeIndex)
      continue
    }
    if (operation.action === 'delete') {
      state.checkpoints.delete(operation.name)
      continue
    }
    const target = operation.name === undefined
      ? nodeIndex === undefined ? state.head : state.nodes[nodeIndex]?.parent
      : state.checkpoints.get(operation.name)
    if (operation.name !== undefined && target === undefined) {
      throw new Error(`session log restores unknown REPL state "${operation.name}"`)
    }
    state.head = target
    state.trusted = true
    state.volatileSuffix.length = 0
    restored = true
  }
  return restored
}

/** Fold the session log into the last exactly replayable frontier. */
export function recoverJournal(session, currentCallId) {
  const events = session?.events
  if (!Array.isArray(events)) {
    return { nodes: [], head: undefined, checkpoints: new Map(), volatileSuffix: [], available: true }
  }
  const calls = []
  const results = new Map()
  let found = false
  for (const event of events) {
    if (event?.type === 'tool/call' && event.data?.name === 'run_code'
      && (currentCallId === undefined || String(event.data.callId) !== String(currentCallId))) {
      calls.push(event)
    }
    if (event?.type !== 'tool/result') continue
    const sourceSeq = event.sourceEventSeqs?.[0]
    if (!Number.isSafeInteger(sourceSeq)) continue
    const meta = event.data?.meta
    if (!isRecord(meta) || !Object.hasOwn(meta, JOURNAL_KEY)) continue
    if (results.has(sourceSeq)) throw new Error(`session log contains duplicate PTC journal results for call seq ${sourceSeq}`)
    try {
      results.set(sourceSeq, { journal: journalFromResult(event) })
      found = true
    } catch (error) {
      results.set(sourceSeq, { error: error.message })
    }
  }

  const state = {
    nodes: [],
    head: undefined,
    checkpoints: new Map(),
    volatileSuffix: [],
    trusted: true,
  }
  const confirmedNoops = new Set()
  for (const { journal } of results.values()) {
    for (const callId of journal?.confirms ?? []) confirmedNoops.add(callId)
  }
  for (const call of calls) {
    const code = sourceForCall(call)
    const result = results.get(call.seq)
    if (result?.journal === undefined && confirmedNoops.has(String(call.data.callId))) continue
    if (code === undefined || result?.journal === undefined) {
      state.trusted = false
      state.volatileSuffix.push({ seq: call.seq, code, reason: result?.error ?? 'missing dsh-ptc-plus journal result' })
      continue
    }
    const journal = result.journal
    if (journal.status === 'noop') continue
    if (journal.status === 'discarded') {
      if (journal.volatileReason !== undefined) {
        state.trusted = false
        state.volatileSuffix.push({ seq: call.seq, code, reason: journal.volatileReason })
      }
      continue
    }
    if (journal.status === 'volatile') {
      state.trusted = false
      state.volatileSuffix.push({ seq: call.seq, code, reason: journal.volatileReason ?? 'volatile cell' })
      applyOperations(state, journal.operations, undefined, false)
      continue
    }
    if (!state.trusted) {
      // A durable cell can only be emitted after the live kernel has restored
      // its last durable frontier. It therefore starts a new trusted branch
      // and permanently abandons the preceding volatile/unknown suffix.
      state.trusted = true
      state.volatileSuffix.length = 0
    }
    const node = Object.freeze({ code, journal, parent: state.head })
    const index = state.nodes.push(node) - 1
    state.head = index
    applyOperations(state, journal.operations, index, true)
  }
  return {
    nodes: state.nodes,
    head: state.head,
    checkpoints: state.checkpoints,
    volatileSuffix: state.volatileSuffix,
    available: found,
  }
}

/** Return source nodes from the empty state to a selected durable head. */
export function pathToHead(state) {
  const path = []
  for (let cursor = state.head; cursor !== undefined;) {
    const node = state.nodes[cursor]
    if (node === undefined) throw new Error('invalid dsh-ptc-plus journal head')
    path.push(node)
    cursor = node.parent
  }
  path.reverse()
  return path
}

/** Merge the journal into the tool result's private metadata. */
export function withJournal(meta, journal) {
  const base = isRecord(meta) ? { ...meta } : meta === undefined ? {} : { value: cloneJson(meta) }
  base[JOURNAL_KEY] = normalizeJournal(journal)
  return base
}

export function assertStateName(name) {
  if (!validName(name)) {
    throw new Error('REPL state name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}')
  }
  return name
}
