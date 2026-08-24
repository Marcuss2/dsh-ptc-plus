import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { Config } from '../index.js'
import { normalizeJournal } from '../internal/session-journal.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { decodeValue, encodeValue, renderValueWire } from '../internal/value-wire.js'
import { JOURNAL_POLICY, appendOnlySession, appendRunCodeEvents, fixture } from './plugin-fixture.js'

test('rejects replaced, corrupt, or extended persisted journals during confirmation', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const replaced = await state.runDurable('replaced-journal', 'const replacedJournalValue = 1', {}, {
    finalizeResult(result) {
      return {
        ...result,
        meta: {
          ...result.meta,
          dshPtcPlus: {
            version: 3,
            rewritePolicy: JOURNAL_POLICY,
            status: 'noop',
            calls: [],
            operations: [],
            confirms: [],
          },
        },
      }
    },
  })
  assert.equal(replaced.meta.dshPtcPlus.status, 'noop')
  const afterReplacement = await state.runDurable('replaced-journal', 'return replacedJournalValue')
  assert.equal(afterReplacement.value, 1)
  assert.equal(afterReplacement.meta.dshPtcPlus.status, 'volatile')

  const corrupt = await state.runDurable('corrupt-journal', 'const corruptJournalValue = 2', {}, {
    finalizeResult(result) {
      return { ...result, meta: { ...result.meta, dshPtcPlus: { version: 2 } } }
    },
  })
    assert.deepEqual(corrupt.meta.dshPtcPlus, { version: 2 })
  const afterCorruption = await state.runDurable('corrupt-journal', 'return corruptJournalValue')
  assert.equal(afterCorruption.value, 2)
  assert.equal(afterCorruption.meta.dshPtcPlus.status, 'volatile')

  const extended = await state.runDurable('extended-journal', 'const extendedJournalValue = 3', {}, {
    finalizeResult(result) {
      return {
        ...result,
        meta: {
          ...result.meta,
          dshPtcPlus: { ...result.meta.dshPtcPlus, injected: true },
        },
      }
    },
  })
  assert.equal(extended.meta.dshPtcPlus.injected, true)
  const afterExtension = await state.runDurable('extended-journal', 'return extendedJournalValue')
  assert.equal(afterExtension.value, 3)
  assert.equal(afterExtension.meta.dshPtcPlus.status, 'volatile')

  const extendedDiagnostic = await state.runDurable(
    'extended-diagnostic',
    'const diagnosticJournalValue = 4\nthrow new Error("expected failure")',
    {},
    {
      finalizeResult(result) {
        const diagnostics = result.meta.dshPtcPlus.diagnostics.map((item, index) => (
          index === 0 ? { ...item, injected: true } : item
        ))
        return {
          ...result,
          meta: {
            ...result.meta,
            dshPtcPlus: { ...result.meta.dshPtcPlus, diagnostics },
          },
        }
      },
    },
  )
  assert.equal(extendedDiagnostic.meta.dshPtcPlus.diagnostics[0].injected, true)
  const afterDiagnosticExtension = await state.runDurable('extended-diagnostic', 'return diagnosticJournalValue')
  assert.equal(afterDiagnosticExtension.value, 4)
  assert.equal(afterDiagnosticExtension.meta.dshPtcPlus.status, 'volatile')
})
test('confirms pre-dispatch no-ops in the next durable journal', async (t) => {
  const events = []
  const session = { id: 'session-confirm-noop', events }
  const first = fixture()
  t.after(() => first.dispose())

  const rejectedCode = 'const rejectedBinding = 1'
  events.push({
    seq: 0,
    type: 'tool/call',
    data: {
      callId: 'pre-denied-call',
      name: 'run_code',
      arguments: JSON.stringify({ code: rejectedCode, description: 'test cell' }),
    },
  })
  const rejected = await first.rejectBeforeRuntime(session.id, {
    callId: 'pre-denied-call',
    session,
  })
  events.push({ seq: 1, type: 'tool/result', sourceEventSeqs: [0], data: { meta: rejected.meta } })

  const durableCode = 'const acceptedBinding = 2'
  const durable = await first.runDurable(session.id, durableCode, {}, { session })
  assert.deepEqual(durable.meta.dshPtcPlus.confirms, [0])
  appendRunCodeEvents(events, 'accepted-call', durableCode, durable)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  const result = await restored.run(session.id, `
return { rejected: typeof rejectedBinding, acceptedBinding }
`, {}, { session })
  assert.deepEqual(result.value, { rejected: 'undefined', acceptedBinding: 2 })
  assert.deepEqual(result.logs, [])
})

test('reconstructs the live REPL from only session-log journal metadata', async (t) => {
  const events = []
  const first = fixture()
  const session = { id: 'session-a', events }
  t.after(() => first.dispose())

  let originalCalls = 0
  const firstCode = 'const persistedValue = await tools.readValue({})'
  const firstResult = await first.runDurable('session-a', firstCode, {
    readValue: async () => { originalCalls++; return 40 },
  }, { session })
  assert.equal(originalCalls, 1)
  appendRunCodeEvents(events, 'call-1', firstCode, firstResult)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  let replayedExternalCalls = 0
  let invoked = 0
  const secondCode = 'return persistedValue + await tools.answer({})'
  const secondResult = await restored.runDurable('session-a', secondCode, {
    readValue: async () => { replayedExternalCalls++; throw new Error('replayed external call') },
    answer: async () => { invoked++; return 2 },
  }, { session })
  assert.deepEqual(secondResult.value, 42)
  assert.equal(invoked, 1)
  assert.equal(replayedExternalCalls, 0)
})

test('replays imports without consuming user bindings that resemble private namespaces', async (t) => {
  const events = []
  const session = { id: 'import-private-replay', events }
  const first = fixture()
  t.after(() => first.dispose())

  const userCode = 'const __dsh_ptc_import_namespace_0__ = 99'
  const userResult = await first.runDurable(session.id, userCode, {}, { session })
  appendRunCodeEvents(events, 'private-user-binding', userCode, userResult)

  const importCode = "import { inspect } from 'node:util'; const inspectType = typeof inspect"
  const importResult = await first.runDurable(session.id, importCode, {}, { session })
  assert.equal(importResult.meta.dshPtcPlus.status, 'durable')
  appendRunCodeEvents(events, 'private-import-binding', importCode, importResult)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, [
    'return [__dsh_ptc_import_namespace_0__, inspectType, typeof inspect]',
  ].join('\n'), {}, { session }), {
    logs: [],
    value: [99, 'function', 'function'],
  })
})

test('replays concurrent native tool calls in their recorded settlement order', async (t) => {
  const events = []
  const first = fixture()
  const session = { id: 'session-race', events }
  t.after(() => first.dispose())
  const code = `
const recordedWinner = await Promise.race([
  tools.slow({}),
  tools.fast({}),
])
`
  const result = await first.runDurable('session-race', code, {
    slow: async () => new Promise(resolve => setTimeout(() => resolve('slow'), 25)),
    fast: async () => 'fast',
  }, { session })
  appendRunCodeEvents(events, 'call-race', code, result)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  let repeated = 0
  const read = await restored.runDurable('session-race', 'return recordedWinner', {
    slow: async () => { repeated++; return 'wrong' },
    fast: async () => { repeated++; return 'wrong' },
  }, { session })
  assert.equal(read.value, 'fast')
  assert.equal(repeated, 0)
})

test('repl.state saves and restores a named branch without model-visible ids', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  assert.deepEqual(await state.run('session-a', `
let branchValue = 1
void await repl.state({ action: 'save', name: 'before-change' })
`), { logs: [] })
  assert.deepEqual(await state.run('session-a', `
branchValue = 2
void await repl.state({ action: 'restore', name: 'before-change' })
`), { logs: [] })
  assert.deepEqual(await state.run('session-a', 'return branchValue'), { logs: [], value: 1 })
})

test('drops a tentative save when the cell becomes volatile at runtime', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const result = await state.runDurable('late-volatile-save', `
void await repl.state({ action: 'save', name: 'must-not-persist' })
return Math['ran' + 'dom']()
`)
  assert.equal(result.meta.dshPtcPlus.status, 'volatile')
  assert.deepEqual(result.meta.dshPtcPlus.operations, [])
  assert.deepEqual(await state.run('late-volatile-save', `
return await repl.state({ action: 'list' })
`), {
    logs: [],
    value: { names: [], mode: 'volatile', volatileReason: 'Math.random' },
  })
})

test('can explicitly restore a durable state from a volatile suffix', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.run('volatile-restore', `
let restoredValue = 1
void await repl.state({ action: 'save', name: 'stable' })
`)
  await state.run('volatile-restore', `
restoredValue = 2
void Math.random()
`)
  const restored = await state.runDurable('volatile-restore', `
void await repl.state({ action: 'restore', name: 'stable' })
`)
  assert.equal(restored.meta.dshPtcPlus.status, 'volatile')
  assert.deepEqual(await state.run('volatile-restore', 'return restoredValue'), {
    logs: [],
    value: 1,
  })
})

test('restores the last durable head without a named checkpoint', async (t) => {
  const events = []
  const session = { id: 'restore-durable-head', events }
  const first = fixture()
  t.after(() => first.dispose())

  const durableCode = 'let unnamedRestoreValue = 1'
  const durable = await first.runDurable(session.id, durableCode, {}, { session })
  appendRunCodeEvents(events, 'unnamed-durable', durableCode, durable)

  const volatileCode = 'unnamedRestoreValue = 2; void Math.random()'
  const volatile = await first.runDurable(session.id, volatileCode, {}, { session })
  appendRunCodeEvents(events, 'unnamed-volatile', volatileCode, volatile)

  const restoreCode = 'return await repl.state({ action: "restore" })'
  const restoredHead = await first.runDurable(session.id, restoreCode, {}, { session })
  assert.deepEqual(restoredHead.value, { action: 'restore', restored: true })
  assert.deepEqual(restoredHead.meta.dshPtcPlus.operations, [{ action: 'restore' }])
  appendRunCodeEvents(events, 'unnamed-restore', restoreCode, restoredHead)

  assert.deepEqual(await first.run(session.id, `
return { value: unnamedRestoreValue, state: await repl.state({ action: 'list' }) }
`), {
    logs: [],
    value: { value: 1, state: { names: [], mode: 'durable' } },
  })
  await first.dispose()

  const cold = fixture()
  t.after(() => cold.dispose())
  assert.deepEqual(await cold.run(session.id, 'return unnamedRestoreValue', {}, { session }), {
    logs: [],
    value: 1,
  })
})

test('named REPL branches survive transfer as session-log data alone', async (t) => {
  const events = []
  const session = { id: 'session-branches', events }
  const first = fixture()
  const cells = [
    `let durableBranch = 1; void await repl.state({ action: 'save', name: 'one' })`,
    `durableBranch = 2; void await repl.state({ action: 'save', name: 'two' })`,
    `void await repl.state({ action: 'restore', name: 'one' })`,
  ]
  for (const [index, code] of cells.entries()) {
    const result = await first.runDurable('session-branches', code, {}, { session })
    appendRunCodeEvents(events, `branch-${index}`, code, result)
  }
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  const inspect = await restored.runDurable('session-branches', `
const listedStates = await repl.state({ action: 'list' })
return { durableBranch, names: listedStates.names }
`, {}, { session })
  assert.deepEqual(inspect.value, { durableBranch: 1, names: ['one', 'two'] })

  const switchResult = await restored.runDurable('session-branches', `
void await repl.state({ action: 'restore', name: 'two' })
`, {}, { session })
  assert.equal(switchResult.isError, false)
  assert.deepEqual(await restored.run('session-branches', 'return durableBranch'), { logs: [], value: 2 })
})

test('restores one imported binding catalog before live and cold continuation', async (t) => {
  const events = []
  const session = { id: 'import-catalog-restore', events }
  const first = fixture()
  const imported = [
    "import { inspect } from 'node:util'",
    'const importedInspect = value => inspect(value)',
    "void await repl.state({ action: 'save', name: 'imported' })",
  ].join('\n')
  const importedResult = await first.runDurable(session.id, imported, {}, { session })
  appendRunCodeEvents(events, 'catalog-import', imported, importedResult)

  const shadow = "const inspect = () => 'shadowed'"
  const shadowResult = await first.runDurable(session.id, shadow, {}, { session })
  appendRunCodeEvents(events, 'catalog-shadow', shadow, shadowResult)
  assert.deepEqual(await first.run(session.id, 'return [inspect({ a: 1 }), importedInspect({ a: 1 })]'), {
    logs: [], value: ['shadowed', '{ a: 1 }'],
  })

  const restore = "void await repl.state({ action: 'restore', name: 'imported' })"
  const restoreResult = await first.runDurable(session.id, restore, {}, { session })
  appendRunCodeEvents(events, 'catalog-restore', restore, restoreResult)
  assert.deepEqual(await first.run(session.id, 'return [inspect({ a: 1 }), importedInspect({ a: 1 })]'), {
    logs: [], value: ['{ a: 1 }', '{ a: 1 }'],
  })
  await first.dispose()

  const cold = fixture()
  t.after(() => cold.dispose())
  assert.deepEqual(await cold.run(session.id, 'return [inspect({ a: 1 }), importedInspect({ a: 1 })]', {}, { session }), {
    logs: [], value: ['{ a: 1 }', '{ a: 1 }'],
  })
})

test('contracts a broken replay node and continues the current request', async (t) => {
  const state = fixture({ computeMs: 20, maxWallMs: 1_000 })
  t.after(() => state.dispose())
  const events = []
  const session = appendOnlySession('replay-timeout', events)
  appendRunCodeEvents(events, 'timed-out-history', 'for (;;) {}', {
    meta: {
      dshPtcPlus: {
        version: 3,
        bindingMode: 'loose',
        rewritePolicy: JOURNAL_POLICY,
        status: 'durable',
        calls: [],
        operations: [],
        confirms: [],
        diagnostics: [],
        completion: {
          kind: 'throw',
          error: { kind: 'timeout', message: 'recorded timeout' },
        },
      },
    },
  })

  const result = await state.run(session.id, 'return 1', {}, { session })
  assert.equal(result.value, 1)
  assert.match(result.logs[0], /Restored the durable head and skipped 1/)
  const boundary = session.events.find(event => event.type === 'ptc-plus/recovery-boundary')
  assert.deepEqual(boundary?.data, { failedCallSeq: 0, frontierCallSeq: null })
})

test('contracts a live derived edit node by its persisted outer call sequence', async (t) => {
  const events = []
  const session = appendOnlySession('live-replay-contraction', events)
  const runtime = new SessionRuntime({ computeMs: 100, maxWallMs: 1_000 })
  t.after(() => runtime.dispose())

  const executeConfirmed = async (callId, program, options = {}) => {
    const name = options.name ?? 'run_code'
    const call = session.append('tool/call', {
      turn: 0,
      step: 0,
      callId,
      name,
      arguments: JSON.stringify(name === 'run_code'
        ? { code: program, description: 'test cell' }
        : { edits: [{ old_string: options.targetSource, new_string: program }] }),
    })
    const context = {
      id: session.id,
      session,
      callId: name === 'run_code' ? callId : `${callId}:derived`,
      ...(name === 'edit_run_code' ? { persistedCallSeq: call.seq } : {}),
    }
    const result = await runtime.run(context, {
      program,
      bindings: [],
      signal: new AbortController().signal,
    })
    runtime.finalize(context, true)
    events.push(Object.freeze({
      type: 'tool/result',
      seq: events.length,
      time: events.length,
      sourceEventSeqs: [call.seq],
      data: {
        meta: {
          dshPtcPlus: normalizeJournal(context.journal),
          ...(name === 'edit_run_code' ? {
            dshPtcPlusEdit: { targetCallSeq: options.targetCallSeq },
            dshPtcPlusDerivedRun: { code: program, description: 'derived edit' },
          } : {}),
        },
      },
    }))
    return { call, context, result }
  }

  const parent = await executeConfirmed('live-parent', 'const stableHead = 3')
  assert.equal(parent.result.error, undefined)
  const child = await executeConfirmed(
    'live-child',
    'const failedHead = stableHead + 4; return failedHead',
    {
      name: 'edit_run_code',
      targetCallSeq: parent.call.seq,
      targetSource: 'const stableHead = 3',
    },
  )
  assert.equal(child.result.value, 7)
  assert.deepEqual(
    child.context.kernel.history.nodes.map(node => node.callSeq),
    [parent.call.seq, child.call.seq],
  )

  const childNode = child.context.kernel.history.nodes[1]
  child.context.kernel.history.nodes[1] = Object.freeze({
    ...childNode,
    journal: normalizeJournal({
      ...childNode.journal,
      completion: { kind: 'return', hasValue: true, value: encodeValue(999) },
    }),
  })
  await child.context.kernel.client.reset(child.context.kernel.client.worker)
  child.context.kernel.rollbackToDurable()

  const fresh = await executeConfirmed(
    'live-fresh',
    `const freshHead = stableHead + 10
return { stableHead, failedType: typeof failedHead, freshHead }`,
  )
  assert.deepEqual(fresh.result.value, {
    stableHead: 3,
    failedType: 'undefined',
    freshHead: 13,
  })
  const boundary = events.find(event => event.type === 'ptc-plus/recovery-boundary')
  assert.deepEqual(boundary?.data, {
    failedCallSeq: child.call.seq,
    frontierCallSeq: parent.call.seq,
  })
  assert.ok(boundary.seq > fresh.call.seq)
  assert.ok(boundary.seq < events.at(-1).seq)

  const restarted = new SessionRuntime({ computeMs: 100, maxWallMs: 1_000 })
  t.after(() => restarted.dispose())
  const inspectCall = session.append('tool/call', {
    turn: 0,
    step: 1,
    callId: 'live-inspect',
    name: 'run_code',
    arguments: JSON.stringify({ code: 'return [stableHead, typeof failedHead, freshHead]', description: 'test cell' }),
  })
  const inspected = await restarted.run(
    { id: session.id, session, callId: inspectCall.data.callId },
    {
      program: 'return [stableHead, typeof failedHead, freshHead]',
      bindings: [],
      signal: new AbortController().signal,
    },
  )
  assert.deepEqual(inspected, { logs: [], value: [3, 'undefined', 13] })
})

test('rejects an ambiguous live run_code event identity before execution', async (t) => {
  const events = []
  const session = appendOnlySession('ambiguous-live-call', events)
  session.append('tool/call', {
    callId: 'duplicate-call',
    name: 'run_code',
    arguments: JSON.stringify({ code: 'return 1', description: 'first' }),
  })
  session.append('tool/call', {
    callId: 'duplicate-call',
    name: 'run_code',
    arguments: JSON.stringify({ code: 'return 2', description: 'second' }),
  })
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())

  const result = await runtime.run(
    { id: session.id, session, callId: 'duplicate-call' },
    {
      program: 'return 2',
      bindings: [],
      signal: new AbortController().signal,
    },
  )
  assert.equal(result.error.kind, 'recovery')
  assert.match(result.error.message, /multiple unpaired run_code calls/)
})

test('rejects an invalid explicit persisted call sequence before execution', async (t) => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const result = await runtime.run({
    id: 'invalid-explicit-call-seq',
    session: { events: [] },
    callId: 'derived',
    persistedCallSeq: -1,
  }, {
    program: 'return 1',
    bindings: [],
    signal: new AbortController().signal,
  })
  assert.equal(result.error.kind, 'recovery')
  assert.match(result.error.message, /persisted tool call sequence must be a non-negative safe integer/)
})

test('rejects a malformed recovery boundary before executing the current cell', async (t) => {
  const callId = 'current-after-malformed-boundary'
  const session = {
    id: 'malformed-recovery-boundary',
    events: [
      {
        type: 'ptc-plus/recovery-boundary',
        data: { failedCallSeq: 1, frontierCallSeq: null },
      },
      {
        seq: 2,
        type: 'tool/call',
        data: {
          callId,
          name: 'run_code',
          arguments: JSON.stringify({ code: 'globalThis.__malformed_boundary_ran__ = true', description: 'current' }),
        },
      },
    ],
  }
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const result = await runtime.run(
    { id: session.id, session, callId },
    {
      program: 'globalThis.__malformed_boundary_ran__ = true',
      bindings: [],
      signal: new AbortController().signal,
    },
  )
  assert.equal(result.error.kind, 'recovery')
  assert.match(result.error.message, /invalid dsh-ptc-plus recovery boundary event sequence/)
  assert.equal(runtime.kernels.has(session.id), false)
})

test('attaches post-recovery cells to the verified frontier across restarts', async (t) => {
  const events = []
  const session = appendOnlySession('replay-detach', events)
  appendRunCodeEvents(events, 'stable-head', 'const stableHead = 3', {
    meta: {
      dshPtcPlus: normalizeJournal({
        version: 3,
        bindingMode: 'loose',
        rewritePolicy: JOURNAL_POLICY,
        status: 'durable',
        calls: [],
        operations: [],
        confirms: [],
        diagnostics: [],
        completion: { kind: 'return', hasValue: false },
      }),
    },
  })
  appendRunCodeEvents(events, 'timed-out-history', 'for (;;) {}', {
    meta: {
      dshPtcPlus: {
        version: 3,
        bindingMode: 'loose',
        rewritePolicy: JOURNAL_POLICY,
        status: 'durable',
        calls: [],
        operations: [],
        confirms: [],
        diagnostics: [],
        completion: { kind: 'throw', error: { kind: 'timeout', message: 'recorded timeout' } },
      },
    },
  })
  events[3].data.meta.dshPtcPlus = normalizeJournal(events[3].data.meta.dshPtcPlus)

  const recovering = fixture({ computeMs: 20, maxWallMs: 1_000 })
  t.after(() => recovering.dispose())
  const confirmed = await recovering.executeRun(
    session.id,
    'const freshHead = stableHead + 4',
    {},
    { session },
  )
  appendRunCodeEvents(events, 'fresh-head', 'const freshHead = stableHead + 4', confirmed.result)
  assert.equal(confirmed.raw.error, undefined)

  const restarted = fixture({ computeMs: 20, maxWallMs: 1_000 })
  t.after(() => restarted.dispose())
  assert.deepEqual(await restarted.run(session.id, 'return [stableHead, freshHead]', {}, { session }), {
    logs: [],
    value: [3, 7],
  })
})
