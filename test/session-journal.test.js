import assert from 'node:assert/strict'
import test from 'node:test'
import {
  JOURNAL_KEY,
  assertStateName,
  createJournal,
  createNoopJournal,
  journalsEqual,
  normalizeJournal,
  pathToHead,
  recoverJournal,
  withJournal,
} from '../internal/session-journal.js'
import { encodeValue } from '../internal/value-wire.js'

function completion(value = 1) {
  return { kind: 'return', hasValue: true, value: encodeValue(value) }
}

function journal(overrides = {}) {
  return {
    version: 1,
    bindingMode: 'loose',
    status: 'durable',
    calls: [],
    operations: [],
    confirms: [],
    diagnostics: [],
    completion: completion(),
    ...overrides,
  }
}

function callEvent(seq, callId, code) {
  return { seq, type: 'tool/call', data: { name: 'run_code', callId, arguments: JSON.stringify({ code }) } }
}

function resultEvent(sourceSeq, value) {
  return { type: 'tool/result', sourceEventSeqs: [sourceSeq], data: { meta: { [JOURNAL_KEY]: value } } }
}

test('normalizes complete journal values and detaches nested value wires', () => {
  const value = journal({
    bindingMode: 'strict',
    calls: [
      { global: 'code', member: 'run', args: encodeValue({ code: 'child-a' }), ok: false, error: 'missing', settle: 1 },
      { global: 'code', member: 'run', args: encodeValue({ code: 'child-b' }), ok: true, value: encodeValue(undefined), settle: 0 },
    ],
    operations: [
      { action: 'save', name: 'point.one' },
      { action: 'restore' },
      { action: 'delete', name: 'point.one' },
    ],
    cordisEffects: [{
      parent: 0,
      member: 'define',
      args: encodeValue({ target: { kind: 'new', prefix: 'demo' } }),
      ok: true,
      value: encodeValue({ pluginId: 'demo-1', packageId: 'pkg-1' }),
    }, {
      parent: 1,
      member: 'stop',
      args: encodeValue({ pluginId: 'demo-1' }),
      ok: false,
      error: 'not running',
    }],
    confirms: ['prior-call'],
    diagnostics: [{
      code: 'PTC-T001', severity: 'note', phase: 'replay', message: 'replayed', stateEffect: 'unchanged',
    }],
    volatileReason: 'ambient Date',
  })
  const normalized = normalizeJournal(value)
  assert.ok(Object.isFrozen(normalized))
  assert.ok(Object.isFrozen(normalized.calls))
  assert.ok(Object.isFrozen(normalized.operations))
  assert.ok(Object.isFrozen(normalized.cordisEffects))
  assert.ok(Object.isFrozen(normalized.confirms))
  assert.ok(Object.isFrozen(normalized.diagnostics))
  assert.deepEqual(normalized.operations, value.operations)
  assert.notEqual(normalized.calls[0].args, value.calls[0].args)
  assert.equal(normalized.volatileReason, 'ambient Date')

  assert.deepEqual(normalizeJournal(journal({
    status: 'discarded',
    completion: undefined,
  })).completion, undefined)
  assert.deepEqual(normalizeJournal(journal({
    completion: { kind: 'return', hasValue: false },
  })).completion, { kind: 'return', hasValue: false })
  assert.deepEqual(normalizeJournal(journal({
    completion: { kind: 'throw', error: { kind: 'TypeError', message: 'bad value' } },
  })).completion, { kind: 'throw', error: { kind: 'TypeError', message: 'bad value' } })
})

test('rejects malformed journal schemas exhaustively', () => {
  const invalid = [
    [null, /invalid dsh-ptc-plus journal/],
    [{}, /invalid dsh-ptc-plus journal/],
    [journal({ bindingMode: 'wide' }), /binding mode/],
    [{ ...journal(), extra: true }, /journal field extra/],
    [journal({ calls: null }), /journal calls/],
    [journal({ calls: [{}] }), /journal call at index 0/],
    [journal({ calls: [{ global: 'g', member: 'm', args: encodeValue(1), ok: true, settle: 0 }] }), /missing its value/],
    [journal({ calls: [{ global: 'g', member: 'm', args: encodeValue(1), ok: false, settle: 0 }] }), /missing its error/],
    [journal({ calls: [{ global: 'g', member: 'm', args: encodeValue(1), ok: false, error: 1, settle: 0 }] }), /missing its error/],
    [journal({ calls: [{ global: 'g', member: 'm', args: encodeValue(1), ok: true, value: encodeValue(1), settle: 1 }] }), /not contiguous/],
    [journal({ operations: null }), /journal operations/],
    [journal({ operations: [{}] }), /journal operation at index 0/],
    [journal({ operations: [{ action: 'save' }] }), /journal operation at index 0/],
    [journal({ operations: [{ action: 'restore', name: '' }] }), /journal operation at index 0/],
    [journal({ cordisEffects: null }), /journal Cordis effects/],
    [journal({ cordisEffects: [{}] }), /Cordis effect at index 0/],
    [journal({ cordisEffects: [{ parent: 0, member: 'future', args: encodeValue({}), ok: true, value: encodeValue(null) }] }), /Cordis effect at index 0/],
    [journal({ cordisEffects: [{ parent: 0, member: 'define', args: encodeValue({}), ok: true }] }), /missing its value/],
    [journal({ cordisEffects: [{ parent: 0, member: 'define', args: encodeValue({}), ok: false }] }), /missing its error/],
    [journal({ cordisEffects: [{ parent: 0, member: 'define', args: encodeValue({}), ok: false, error: 1 }] }), /missing its error/],
    [journal({ cordisEffects: [{ parent: 1, member: 'define', args: encodeValue({}), ok: true, value: encodeValue(null) }] }), /missing parent call/],
    [journal({ calls: [{ global: 'tools', member: 'read', args: encodeValue({}), ok: true, value: encodeValue(null), settle: 0 }], cordisEffects: [{ parent: 0, member: 'define', args: encodeValue({}), ok: true, value: encodeValue(null) }] }), /parent must be code\.run/],
    [journal({ completion: undefined }), /journal completion/],
    [journal({ completion: null }), /journal completion/],
    [journal({ completion: { kind: 'return', hasValue: 'yes', value: encodeValue(1) } }), /journal return value/],
    [journal({ completion: { kind: 'return', hasValue: true } }), /journal return value/],
    [journal({ completion: { kind: 'return', hasValue: false, value: encodeValue(1) } }), /journal return value/],
    [journal({ completion: { kind: 'throw', error: null } }), /journal throw completion/],
    [journal({ completion: { kind: 'throw', error: { kind: 1, message: 'bad' } } }), /journal throw completion/],
    [journal({ confirms: 'call' }), /confirmed no-op/],
    [journal({ confirms: [''] }), /confirmed no-op/],
    [journal({ confirms: ['same', 'same'] }), /duplicate/],
    [journal({ diagnostics: null }), /journal diagnostics/],
    [journal({ diagnostics: [{}] }), /journal diagnostic at index 0/],
    [journal({ status: 'discarded', calls: [{ global: 'g', member: 'm', args: encodeValue(1), ok: true, value: encodeValue(1), settle: 0 }], completion: undefined }), /must not contain/],
    [journal({ volatileReason: 42 }), /volatile reason/],
  ]
  for (const [value, expected] of invalid) assert.throws(() => normalizeJournal(value), expected)
})

test('creates journals, compares semantics, validates names, and merges metadata', () => {
  assert.deepEqual(createJournal(['a'], 'strict'), {
    version: 1, bindingMode: 'strict', calls: [], operations: [], confirms: ['a'], diagnostics: [],
  })
  assert.throws(() => createJournal([], 'invalid'), /binding mode/)
  assert.throws(() => createNoopJournal({}, 'invalid'), /binding mode/)
  assert.deepEqual(createNoopJournal({}, 'loose').completion, { kind: 'return', hasValue: false })
  assert.deepEqual(createNoopJournal({ isError: true, error: { message: 'blocked' } }, 'strict').completion, {
    kind: 'throw', error: { kind: 'pipeline', message: 'blocked' },
  })
  assert.equal(createNoopJournal({ isError: true }, 'loose').completion.error.message, 'tool call rejected before dispatch')

  const value = journal()
  assert.equal(journalsEqual(value, structuredClone(value)), true)
  assert.equal(journalsEqual(value, journal({ status: 'volatile' })), false)
  assert.equal(journalsEqual(value, null), false)
  assert.equal(assertStateName('A.state-1'), 'A.state-1')
  for (const name of ['', '.bad', 'bad/name', 'x'.repeat(65), 42]) {
    assert.throws(() => assertStateName(name), /REPL state name/)
  }

  assert.deepEqual(withJournal(undefined, value)[JOURNAL_KEY], normalizeJournal(value))
  assert.deepEqual(withJournal({ existing: true }, value).existing, true)
  assert.equal(withJournal('legacy', value).value, 'legacy')
})

test('recovers durable branches, checkpoints, volatile suffixes, and confirmed no-ops', () => {
  const events = [
    callEvent(1, 'one', 'const one = 1'),
    resultEvent(1, journal({ operations: [{ action: 'save', name: 'one' }] })),
    callEvent(2, 'volatile', 'Date.now()'),
    resultEvent(2, journal({ status: 'volatile', operations: [{ action: 'restore', name: 'one' }], volatileReason: 'ambient Date' })),
    callEvent(3, 'discarded', 'discarded()'),
    resultEvent(3, journal({ status: 'discarded', completion: undefined })),
    callEvent(4, 'noop', 'noop()'),
    resultEvent(4, journal({ status: 'noop', completion: undefined })),
    callEvent(5, 'two', 'const two = 2'),
    resultEvent(5, journal({ operations: [{ action: 'delete', name: 'one' }] })),
    callEvent(6, 'confirmed', 'never ran'),
    resultEvent(99, journal({ confirms: ['confirmed'] })),
  ]
  const state = recoverJournal({ events })
  assert.equal(state.available, true)
  assert.deepEqual(pathToHead(state).map(node => node.code), ['const one = 1', 'const two = 2'])
  assert.deepEqual([...state.checkpoints], [])
  assert.deepEqual(state.volatileSuffix, [])

  const absent = recoverJournal()
  assert.deepEqual(absent, { nodes: [], head: undefined, checkpoints: new Map(), volatileSuffix: [], available: true })
  assert.equal(recoverJournal({ events }, 'two').nodes.length, 1)
})

test('marks missing and corrupt recovery data untrusted and rejects invalid histories', () => {
  const malformedArguments = callEvent(1, 'bad-source', 'ignored')
  malformedArguments.data.arguments = '{'
  const missing = recoverJournal({ events: [malformedArguments] })
  assert.equal(missing.available, false)
  assert.equal(missing.volatileSuffix[0].code, undefined)

  const wrongShape = callEvent(2, 'wrong-source', 'ignored')
  wrongShape.data.arguments = JSON.stringify({ code: 42 })
  const corrupt = recoverJournal({ events: [
    wrongShape,
    resultEvent(2, { ...journal(), status: 'invalid' }),
  ] })
  assert.match(corrupt.volatileSuffix[0].reason, /invalid dsh-ptc-plus journal/)

  const duplicate = resultEvent(1, journal())
  assert.throws(() => recoverJournal({ events: [duplicate, duplicate] }), /duplicate PTC journal/)
  assert.throws(() => pathToHead({ head: 2, nodes: [] }), /invalid dsh-ptc-plus journal head/)

  const unknownRestore = [
    callEvent(1, 'one', 'return 1'),
    resultEvent(1, journal({ operations: [{ action: 'restore', name: 'missing' }] })),
  ]
  assert.throws(() => recoverJournal({ events: unknownRestore }), /restores unknown REPL state/)

  const volatileSave = [
    callEvent(1, 'one', 'Date.now()'),
    resultEvent(1, journal({ status: 'volatile', operations: [{ action: 'save', name: 'bad' }] })),
  ]
  assert.throws(() => recoverJournal({ events: volatileSave }), /volatile journal cannot save/)
})

test('preserves a discarded external-effect boundary as an untrusted suffix', () => {
  const events = [
    callEvent(1, 'external-discard', 'await mutate()'),
    resultEvent(1, journal({
      status: 'discarded',
      completion: undefined,
      volatileReason: 'cordis.define',
    })),
  ]
  const state = recoverJournal({ events })
  assert.equal(state.nodes.length, 0)
  assert.deepEqual(state.volatileSuffix, [{ seq: 1, code: 'await mutate()', reason: 'cordis.define' }])
})

test('handles omitted confirms, unrelated results, and unnamed parent restores', () => {
  const withoutConfirms = journal()
  delete withoutConfirms.confirms
  assert.deepEqual(normalizeJournal(withoutConfirms).confirms, [])

  const events = [
    { type: 'tool/result', sourceEventSeqs: ['invalid'], data: {} },
    callEvent(1, 'one', 'const one = 1'),
    resultEvent(1, journal()),
    callEvent(2, 'two', 'const two = 2'),
    resultEvent(2, journal({ operations: [{ action: 'restore' }] })),
  ]
  assert.deepEqual(pathToHead(recoverJournal({ events })).map(node => node.code), ['const one = 1'])
})
