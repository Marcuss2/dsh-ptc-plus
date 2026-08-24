import { decodeValue, encodeValue, normalizeValueWire } from './value-wire.js'
import { normalizeDiagnostic } from './diagnostic.js'
import { assertOwnFields, isRecord } from './record-utils.js'

export const JOURNAL_KEY = 'dshPtcPlus'
export const EDIT_TARGET_KEY = 'dshPtcPlusEdit'
export const DERIVED_RUN_KEY = 'dshPtcPlusDerivedRun'
export const REWRITES_KEY = 'dshPtcPlusRewrites'
export const JOURNAL_VERSION = 3
const LEGACY_JOURNAL_VERSION = 1
const INTERMEDIATE_JOURNAL_VERSION = 2
export const RECOVERY_BOUNDARY_EVENT = 'ptc-plus/recovery-boundary'

const STATUSES = new Set(['durable', 'volatile', 'discarded', 'noop'])
const BINDING_MODES = new Set(['loose', 'strict'])
const JOURNAL_FIELDS = new Set(['version', 'bindingMode', 'rewritePolicy', 'status', 'calls', 'operations', 'confirms', 'diagnostics', 'completion', 'volatileReason'])
const LEGACY_JOURNAL_FIELDS = new Set([...JOURNAL_FIELDS].filter(field => field !== 'rewritePolicy'))
const REWRITE_POLICY_FIELDS = new Set(['autoRewriteImports', 'autoStripExports', 'autoSplitRedeclarations'])
const CALL_SUCCESS_FIELDS = new Set(['global', 'member', 'args', 'ok', 'value', 'settle'])
const CALL_ERROR_FIELDS = new Set(['global', 'member', 'args', 'ok', 'error', 'settle'])
const OPERATION_FIELDS = new Set(['action', 'name'])
const RETURN_FIELDS = new Set(['kind', 'hasValue', 'value'])
const THROW_FIELDS = new Set(['kind', 'error'])
const ERROR_FIELDS = new Set(['kind', 'message'])
const EDIT_TARGET_FIELDS = new Set(['targetCallSeq'])
const DERIVED_RUN_FIELDS = new Set(['code', 'description'])

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

const LEGACY_REWRITE_POLICY = Object.freeze({
  autoRewriteImports: false,
  autoStripExports: false,
  autoSplitRedeclarations: false,
})

function normalizeLegacyConfirms(value, resolveLegacyConfirm) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(callId => typeof callId !== 'string' || callId.length === 0)) {
    throw new Error('invalid dsh-ptc-plus confirmed no-op calls')
  }
  if (new Set(value).size !== value.length) throw new Error('duplicate dsh-ptc-plus confirmed no-op call')
  if (value.length === 0) return []
  if (typeof resolveLegacyConfirm !== 'function') {
    throw new Error('legacy dsh-ptc-plus confirmed no-op calls require session call identity')
  }
  const confirms = value.map(callId => resolveLegacyConfirm(callId))
  if (confirms.some(callSeq => !Number.isSafeInteger(callSeq) || callSeq < 0)) {
    throw new Error('legacy dsh-ptc-plus confirmed no-op call is not uniquely persisted')
  }
  if (new Set(confirms).size !== confirms.length) {
    throw new Error('duplicate dsh-ptc-plus confirmed no-op call')
  }
  return confirms
}

function normalizeConfirms(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(callSeq => !Number.isSafeInteger(callSeq) || callSeq < 0)) {
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

function normalizeRewritePolicy(value) {
  if (!isRecord(value)) throw new Error('invalid dsh-ptc-plus journal rewrite policy')
  assertOwnFields(value, REWRITE_POLICY_FIELDS, 'journal rewrite policy')
  for (const key of REWRITE_POLICY_FIELDS) {
    if (typeof value[key] !== 'boolean') throw new Error(`invalid dsh-ptc-plus journal rewrite policy ${key}`)
  }
  return Object.freeze({
    autoRewriteImports: value.autoRewriteImports,
    autoStripExports: value.autoStripExports,
    autoSplitRedeclarations: value.autoSplitRedeclarations,
  })
}

function migrateJournal(value, resolveLegacyConfirm) {
  if (value.version !== LEGACY_JOURNAL_VERSION) return value
  assertOwnFields(value, LEGACY_JOURNAL_FIELDS, 'dsh-ptc-plus journal')
  return {
    ...value,
    version: JOURNAL_VERSION,
    rewritePolicy: LEGACY_REWRITE_POLICY,
    confirms: normalizeLegacyConfirms(value.confirms, resolveLegacyConfirm),
  }
}

/** Validate and detach one journal emitted by the runtime. */
export function normalizeJournal(value, options = {}) {
  if (!isRecord(value)) throw new Error('invalid dsh-ptc-plus journal')
  if (![LEGACY_JOURNAL_VERSION, INTERMEDIATE_JOURNAL_VERSION, JOURNAL_VERSION].includes(value.version)
    || !STATUSES.has(value.status)) {
    throw new Error('invalid dsh-ptc-plus journal')
  }
  const migrated = migrateJournal(value, options.resolveLegacyConfirm)
  assertOwnFields(migrated, JOURNAL_FIELDS, 'dsh-ptc-plus journal')
  if (!BINDING_MODES.has(migrated.bindingMode)) throw new Error('invalid dsh-ptc-plus journal binding mode')
  const rewritePolicy = normalizeRewritePolicy(migrated.rewritePolicy)
  const calls = normalizeCalls(migrated.calls)
  const operations = normalizeOperations(migrated.operations)
  const confirms = normalizeConfirms(migrated.confirms)
  const diagnostics = normalizeDiagnostics(migrated.diagnostics)
  const completion = normalizeCompletion(
    migrated.completion,
    migrated.status === 'durable' || migrated.status === 'volatile',
  )
  if ((migrated.status === 'discarded' || migrated.status === 'noop')
    && (calls.length !== 0 || operations.length !== 0)) {
    throw new Error(`${migrated.status} dsh-ptc-plus journal must not contain calls or operations`)
  }
  if (migrated.volatileReason !== undefined && typeof migrated.volatileReason !== 'string') {
    throw new Error('invalid dsh-ptc-plus volatile reason')
  }
  if (migrated.volatileReason !== undefined && migrated.status !== 'volatile' && migrated.status !== 'discarded') {
    throw new Error('dsh-ptc-plus volatile reason requires volatile or discarded status')
  }
  return Object.freeze({
    version: JOURNAL_VERSION,
    bindingMode: migrated.bindingMode,
    rewritePolicy,
    status: migrated.status,
    calls: Object.freeze(calls),
    operations: Object.freeze(operations),
    confirms: Object.freeze(confirms),
    diagnostics: Object.freeze(diagnostics),
    ...(completion === undefined ? {} : { completion }),
    ...(migrated.volatileReason === undefined ? {} : { volatileReason: migrated.volatileReason }),
  })
}

/** Validate the required persisted relation that makes one edit result executable history. */
export function normalizeDerivedEditResult(meta, expectedTargetCallSeq) {
  if (!Number.isSafeInteger(expectedTargetCallSeq) || expectedTargetCallSeq < 0) {
    throw new Error('derived edit does not identify an eligible target call')
  }
  if (!isRecord(meta)) throw new Error('invalid dsh-ptc-plus derived edit metadata')
  const target = meta[EDIT_TARGET_KEY]
  const derived = meta[DERIVED_RUN_KEY]
  if (!isRecord(target)) throw new Error('invalid dsh-ptc-plus edit target metadata')
  assertOwnFields(target, EDIT_TARGET_FIELDS, 'edit target metadata')
  if (target.targetCallSeq !== expectedTargetCallSeq) {
    throw new Error('derived edit target does not match the eligible target call')
  }
  if (!isRecord(derived) || typeof derived.code !== 'string' || typeof derived.description !== 'string') {
    throw new Error('invalid dsh-ptc-plus derived run metadata')
  }
  assertOwnFields(derived, DERIVED_RUN_FIELDS, 'derived run metadata')
  const journal = normalizeJournal(meta[JOURNAL_KEY])
  if (journal.status === 'noop') throw new Error('derived edit journal must not be noop')
  return Object.freeze({
    targetCallSeq: target.targetCallSeq,
    code: derived.code,
    description: derived.description,
    journal,
  })
}

/** Compare only the required persisted relation for one derived edit. */
export function derivedEditResultsEqual(leftMeta, rightMeta, expectedTargetCallSeq) {
  try {
    const left = encodeValue(normalizeDerivedEditResult(leftMeta, expectedTargetCallSeq))
    const right = encodeValue(normalizeDerivedEditResult(rightMeta, expectedTargetCallSeq))
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
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

/** Persist a replay contraction without rewriting immutable session history. */
export function appendRecoveryBoundary(session, failedNode, frontierNode) {
  if (typeof session?.append !== 'function') {
    throw new Error('session does not provide the append-only recovery contract')
  }
  if (!Number.isSafeInteger(failedNode?.callSeq)) {
    throw new Error('replay failure does not identify a durable call event')
  }
  session.append(RECOVERY_BOUNDARY_EVENT, {
    failedCallSeq: failedNode.callSeq,
    frontierCallSeq: frontierNode?.callSeq ?? null,
  })
}

/** Resolve the persisted event identity for one named tool call being dispatched. */
export function liveToolCallSeq(session, callId, toolName) {
  const events = session?.events
  if (!Array.isArray(events) || typeof callId !== 'string' || callId.length === 0
    || typeof toolName !== 'string' || toolName.length === 0) return undefined

  const pairedCallSeqs = new Set()
  for (const event of events) {
    if (event?.type !== 'tool/result' || !Array.isArray(event.sourceEventSeqs)) continue
    for (const sourceSeq of event.sourceEventSeqs) {
      if (Number.isSafeInteger(sourceSeq) && sourceSeq >= 0) pairedCallSeqs.add(sourceSeq)
    }
  }

  const candidates = []
  for (const event of events) {
    if (event?.type !== 'tool/call' || event.data?.name !== toolName
      || event.data.callId !== callId || pairedCallSeqs.has(event.seq)) continue
    if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
      throw new Error(`current ${toolName} call has an invalid session event sequence`)
    }
    candidates.push(event.seq)
  }
  if (candidates.length > 1) {
    throw new Error(`session log contains multiple unpaired ${toolName} calls for callId ${JSON.stringify(callId)}`)
  }
  return candidates[0]
}

/** Start a mutable journal for one live cell. */
export function createJournal(confirms = [], bindingMode, rewritePolicy) {
  if (!BINDING_MODES.has(bindingMode)) throw new TypeError('invalid dsh-ptc-plus journal binding mode')
  return {
    version: JOURNAL_VERSION,
    bindingMode,
    rewritePolicy: normalizeRewritePolicy(rewritePolicy),
    calls: [],
    operations: [],
    confirms: [...confirms],
    diagnostics: [],
  }
}

function sourceForRunCall(call) {
  try {
    const args = JSON.parse(call.data.arguments)
    return isRecord(args) && typeof args.code === 'string' ? args.code : undefined
  } catch {
    return undefined
  }
}

/** Return an owned state transition; reject volatile saves and unknown named restores. */
export function reduceStateOperations({ nodes, head, checkpoints }, operations, nodeIndex) {
  const nextCheckpoints = new Map(checkpoints)
  let nextHead = head
  let restored = false
  for (const operation of operations) {
    if (operation.action === 'save') {
      if (nodeIndex === undefined) throw new Error('volatile journal cannot save a durable REPL state')
      nextCheckpoints.set(operation.name, nodeIndex)
      continue
    }
    if (operation.action === 'delete') {
      nextCheckpoints.delete(operation.name)
      continue
    }
    const target = operation.name === undefined
      ? nodeIndex === undefined ? nextHead : nodes[nodeIndex]?.parent
      : nextCheckpoints.get(operation.name)
    if (operation.name !== undefined && target === undefined) {
      throw new Error(`session log restores unknown REPL state "${operation.name}"`)
    }
    nextHead = target
    restored = true
  }
  return { head: nextHead, checkpoints: nextCheckpoints, restored }
}

function applyOperations(state, operations, nodeIndex) {
  const transition = reduceStateOperations(state, operations, nodeIndex)
  state.head = transition.head
  state.checkpoints = transition.checkpoints
  if (transition.restored) {
    state.trusted = true
    state.volatileSuffix.length = 0
  }
}

function normalizeRecoveryBoundary(event) {
  const value = event.data
  if (!isRecord(value)) throw new Error('invalid dsh-ptc-plus recovery boundary')
  assertOwnFields(value, new Set(['failedCallSeq', 'frontierCallSeq']), 'recovery boundary')
  if (!Number.isSafeInteger(value.failedCallSeq) || value.failedCallSeq < 0
    || (value.frontierCallSeq !== null
      && (!Number.isSafeInteger(value.frontierCallSeq) || value.frontierCallSeq < 0))) {
    throw new Error('invalid dsh-ptc-plus recovery boundary')
  }
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
    throw new Error('invalid dsh-ptc-plus recovery boundary event sequence')
  }
  return { ...value, eventSeq: event.seq }
}

function applyRecord(state, record, invalidCallSeqs) {
  const { call, code, result } = record
  if (invalidCallSeqs.has(call.seq)) return
  if (code === undefined || result?.journal === undefined) {
    state.trusted = false
    state.volatileSuffix.push({ seq: call.seq, code, reason: result?.error ?? 'missing dsh-ptc-plus journal result' })
    return
  }
  const journal = result.journal
  if (journal.status === 'noop') return
  if (journal.status === 'discarded') {
    if (journal.volatileReason !== undefined) {
      state.trusted = false
      state.volatileSuffix.push({ seq: call.seq, code, reason: journal.volatileReason })
    }
    return
  }
  if (journal.status === 'volatile') {
    state.trusted = false
    state.volatileSuffix.push({ seq: call.seq, code, reason: journal.volatileReason ?? 'volatile cell' })
    applyOperations(state, journal.operations, undefined)
    return
  }
  if (!state.trusted) {
    state.trusted = true
    state.volatileSuffix.length = 0
  }
  const node = Object.freeze({
    code,
    journal,
    callSeq: call.seq,
    parent: state.head,
  })
  const index = state.nodes.push(node) - 1
  state.head = index
  applyOperations(state, journal.operations, index)
}

function forceRecoveryHead(state, boundary) {
  state.head = boundary.frontierCallSeq === null
    ? undefined
    : state.nodes.findIndex(node => node.callSeq === boundary.frontierCallSeq)
  if (state.head === -1) throw new Error('recovery boundary frontier is not reconstructable')
  state.trusted = true
  state.volatileSuffix = []
}

function recordEventSeq(record) {
  return record.result?.eventSeq ?? record.call.seq
}

function foldRecords(records, invalidCallSeqs, boundaries = []) {
  const state = {
    nodes: [],
    head: undefined,
    checkpoints: new Map(),
    volatileSuffix: [],
    trusted: true,
  }
  let boundaryIndex = 0
  for (const record of records) {
    while (boundaryIndex < boundaries.length && boundaries[boundaryIndex].eventSeq < recordEventSeq(record)) {
      forceRecoveryHead(state, boundaries[boundaryIndex++])
    }
    applyRecord(state, record, invalidCallSeqs)
  }
  while (boundaryIndex < boundaries.length) forceRecoveryHead(state, boundaries[boundaryIndex++])
  return state
}

function dependsOn(nodes, index, ancestor) {
  for (let cursor = index; cursor !== undefined; cursor = nodes[cursor]?.parent) {
    if (cursor === ancestor) return true
  }
  return false
}

/** Fold the session log into the last exactly replayable frontier. */
export function recoverJournal(session, currentCallSeq) {
  const events = session?.events
  if (!Array.isArray(events)) {
    return { nodes: [], head: undefined, checkpoints: new Map(), volatileSuffix: [], available: true }
  }
  const calls = []
  const executableCalls = new Map()
  const boundaries = []
  const results = new Map()
  const callScopes = new Map()
  const editTargets = new Map()
  const editClaims = new Map()
  const claimedEditTargets = new Set()
  const journalResultSeqs = new Set()
  let unavailableResultSeq
  let editScope = 0
  let editableCallSeq
  let found = false
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex]
    if (event?.type === 'turn/start' || event?.type === 'turn/end') {
      editScope += 1
      editableCallSeq = undefined
    }
    if (event?.type === 'tool/call'
      && (event.data?.name === 'run_code' || event.data?.name === 'edit_run_code')) {
      if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
        if (event.seq !== currentCallSeq) calls.push(event)
        continue
      }
      if (executableCalls.has(event.seq)) {
        throw new Error('session log contains a duplicate run_code call sequence')
      }
      executableCalls.set(event.seq, { event, eventIndex })
      callScopes.set(event.seq, editScope)
      if (event.data.name === 'edit_run_code') {
        const targetCallSeq = editableCallSeq
        if (targetCallSeq !== undefined && !claimedEditTargets.has(targetCallSeq)) {
          claimedEditTargets.add(targetCallSeq)
          editClaims.set(event.seq, targetCallSeq)
          editTargets.set(event.seq, targetCallSeq)
        } else {
          editTargets.set(event.seq, undefined)
        }
      }
      if (event.seq !== currentCallSeq) calls.push(event)
    }
    if (event?.type === RECOVERY_BOUNDARY_EVENT) boundaries.push(normalizeRecoveryBoundary(event))
    if (event?.type !== 'tool/result') continue
    const sourceSeq = event.sourceEventSeqs?.[0]
    if (!Number.isSafeInteger(sourceSeq)) continue
    const executable = executableCalls.get(sourceSeq)
    const meta = event.data?.meta
    let normalized
    if (isRecord(meta) && Object.hasOwn(meta, JOURNAL_KEY)) {
      if (journalResultSeqs.has(sourceSeq)) {
        throw new Error(`session log contains duplicate PTC journal results for call seq ${sourceSeq}`)
      }
      journalResultSeqs.add(sourceSeq)
      if (executable === undefined) {
        unavailableResultSeq ??= sourceSeq
        continue
      }
      const raw = {
        meta,
        eventSeq: Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : sourceSeq,
        eventIndex,
      }
      try {
        if (executable.event.data?.name === 'edit_run_code') {
          const derived = normalizeDerivedEditResult(meta, editTargets.get(sourceSeq))
          normalized = { ...raw, journal: derived.journal, derived }
        } else {
          const rawJournal = meta[JOURNAL_KEY]
          const resolveLegacyConfirm = rawJournal?.version === LEGACY_JOURNAL_VERSION
            ? callId => {
              const candidates = [...executableCalls.values()]
                .filter(candidate => candidate.eventIndex < eventIndex
                  && candidate.event.data?.name === 'run_code'
                  && candidate.event.data.callId === callId
                  && !results.has(candidate.event.seq))
              return candidates.length === 1 ? candidates[0].event.seq : undefined
            }
            : undefined
          normalized = {
            ...raw,
            journal: normalizeJournal(rawJournal, { resolveLegacyConfirm }),
          }
        }
      } catch (error) {
        normalized = { ...raw, error: error.message }
      }
      results.set(sourceSeq, normalized)
      found = true
    }
    const claimedTarget = editClaims.get(sourceSeq)
    if (claimedTarget !== undefined) {
      editClaims.delete(sourceSeq)
      if (normalized?.derived === undefined) claimedEditTargets.delete(claimedTarget)
    }
    if (executable === undefined || callScopes.get(sourceSeq) !== editScope) continue
    if (executable.event.data?.name === 'run_code') {
      editableCallSeq = sourceForRunCall(executable.event) === undefined ? undefined : sourceSeq
    } else if (normalized?.derived !== undefined) {
      editableCallSeq = sourceSeq
    }
  }
  if (unavailableResultSeq !== undefined) {
    throw new Error(`PTC journal result references unavailable run_code call seq ${unavailableResultSeq}`)
  }

  const confirmedNoops = new Set()
  for (const { journal, eventIndex } of results.values()) {
    for (const callSeq of journal?.confirms ?? []) {
      const confirmed = executableCalls.get(callSeq)
      if (confirmed === undefined || confirmed.eventIndex >= eventIndex || results.has(callSeq)) {
        throw new Error(`confirmed no-op does not identify an earlier unjournaled run_code call seq ${callSeq}`)
      }
      confirmedNoops.add(callSeq)
    }
  }
  const records = []
  const orderedRecords = []
  const invalidCallSeqs = new Set()
  const appliedBoundaries = []
  let state = foldRecords(records, invalidCallSeqs)
  let boundaryIndex = 0
  const applyBoundariesBefore = (seq) => {
    while (boundaryIndex < boundaries.length && boundaries[boundaryIndex].eventSeq < seq) {
      const boundary = boundaries[boundaryIndex++]
      const failedIndex = state.nodes.findIndex(node => node.callSeq === boundary.failedCallSeq)
      if (failedIndex < 0) throw new Error('recovery boundary references an unavailable failed cell')
      const expectedFrontier = state.nodes[failedIndex].parent
      const frontierIndex = boundary.frontierCallSeq === null
        ? undefined
        : state.nodes.findIndex(node => node.callSeq === boundary.frontierCallSeq)
      if (frontierIndex !== expectedFrontier) {
        throw new Error('recovery boundary does not identify the failed cell parent')
      }
      for (let index = 0; index < state.nodes.length; index += 1) {
        if (dependsOn(state.nodes, index, failedIndex)) invalidCallSeqs.add(state.nodes[index].callSeq)
      }
      appliedBoundaries.push(boundary)
      state = foldRecords(records, invalidCallSeqs, appliedBoundaries)
    }
  }
  for (const call of calls) {
    const result = results.get(call.seq)
    const code = call.data?.name === 'edit_run_code' ? result?.derived?.code : sourceForRunCall(call)
    const record = { call, code, result }
    if (call.data?.name === 'edit_run_code' && record.code === undefined && result === undefined) continue
    if (result?.journal === undefined && confirmedNoops.has(call.seq)) continue
    orderedRecords.push(record)
  }
  orderedRecords.sort((left, right) => (
    recordEventSeq(left) - recordEventSeq(right) || left.call.seq - right.call.seq
  ))
  for (const record of orderedRecords) {
    applyBoundariesBefore(recordEventSeq(record))
    records.push(record)
    applyRecord(state, record, invalidCallSeqs)
  }
  applyBoundariesBefore(Number.POSITIVE_INFINITY)
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

const REWRITE_FIELDS = new Set(['kind', 'description', 'source'])
const REWRITE_KINDS = new Set(['import', 'redeclaration', 'export'])

/** Validate and detach one rewrite record emitted by the runtime. */
export function normalizeRewrites(value) {
  if (!Array.isArray(value)) throw new Error('invalid dsh-ptc-plus rewrites')
  return Object.freeze(value.map((rewrite, index) => {
    if (!isRecord(rewrite) || !REWRITE_KINDS.has(rewrite.kind) || typeof rewrite.description !== 'string'
      || rewrite.description.length === 0) {
      throw new Error(`invalid dsh-ptc-plus rewrite at index ${index}`)
    }
    assertOwnFields(rewrite, REWRITE_FIELDS, `dsh-ptc-plus rewrite at index ${index}`)
    if (rewrite.source !== undefined && typeof rewrite.source !== 'string') {
      throw new Error(`invalid dsh-ptc-plus rewrite source at index ${index}`)
    }
    return Object.freeze({
      kind: rewrite.kind,
      description: rewrite.description,
      ...(rewrite.source === undefined ? {} : { source: rewrite.source }),
    })
  }))
}

/** Read optional rewrite provenance without letting malformed metadata affect settlement. */
export function validatedRewrites(meta) {
  if (!isRecord(meta) || !Object.hasOwn(meta, REWRITES_KEY)) return undefined
  try {
    return normalizeRewrites(meta[REWRITES_KEY])
  } catch {
    return undefined
  }
}

/** Merge rewrite records into the tool result's private metadata. */
export function withRewrites(meta, rewrites) {
  const base = isRecord(meta) ? { ...meta } : meta === undefined ? {} : { value: cloneJson(meta) }
  base[REWRITES_KEY] = normalizeRewrites(rewrites)
  return base
}

export function assertStateName(name) {
  if (!validName(name)) {
    throw new Error('REPL state name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}')
  }
  return name
}
