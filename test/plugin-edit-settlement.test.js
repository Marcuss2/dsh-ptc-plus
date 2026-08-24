import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendOnlySession,
  appendRunCodeEvents,
  fixture,
  ptcAgent,
} from './plugin-fixture.js'
import { RECOVERY_BOUNDARY_KEY } from '../internal/session-journal.js'

function appendEditCall(events, callId, args) {
  const seq = events.length
  events.push({
    type: 'tool/call',
    seq,
    data: { callId, name: 'edit_run_code', arguments: JSON.stringify(args) },
  })
  return seq
}

function appendEditResult(events, callId, callSeq, meta) {
  events.push({
    type: 'tool/result',
    seq: events.length,
    sourceEventSeqs: [callSeq],
    data: { message: { source: { callId } }, meta },
  })
}

test('keeps a derived run tentative until exact outer metadata persists', async (t) => {
  const cases = [
    ['removed', false, () => ({})],
    ['changed', true, meta => ({
      ...meta,
      dshPtcPlusDerivedRun: {
        ...meta.dshPtcPlusDerivedRun,
        code: 'unconfirmedEditValue = 999',
      },
    })],
  ]
  for (const [label, expectsRecoveryBoundary, finalizeMeta] of cases) {
    const events = [{ type: 'turn/start', seq: 0, data: {} }]
    const session = appendOnlySession(`unconfirmed-derived-${label}`, events)
    const state = fixture()
    t.after(() => state.dispose())
    const agent = ptcAgent(session.id, session)
    const requestSignal = new AbortController().signal
    await state.assemble(
      { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
      { agent, scope: agent, signal: requestSignal },
    )

    const setupCode = 'let unconfirmedEditValue = 1; return unconfirmedEditValue'
    const setup = await state.runDurable(session.id, setupCode, {}, { session })
    appendRunCodeEvents(events, `${label}-setup`, setupCode, setup)
    const args = { edits: [{ old_string: '= 1', new_string: '= 2' }] }
    const callId = `${label}-edit`
    const callSeq = appendEditCall(events, callId, args)
    const definition = agent.ctx.tools.get('edit_run_code')
    const presentationMeta = definition.output.presentationMeta
    definition.output.presentationMeta = (editArgs, value) => (
      finalizeMeta(presentationMeta(editArgs, value))
    )
    let edit
    try {
      edit = await state.ctx.tools.execute({
        callId,
        name: 'edit_run_code',
        arguments: args,
        agent,
        signal: requestSignal,
      })
    } finally {
      definition.output.presentationMeta = presentationMeta
    }
    assert.equal(edit.isError, false, JSON.stringify(edit))
    assert.equal(edit.value.edited, true)
    appendEditResult(events, callId, callSeq, edit.meta)

    const dependentCode = [
      'const afterUnconfirmedEdit = unconfirmedEditValue + 1',
      'return [unconfirmedEditValue, afterUnconfirmedEdit]',
    ].join('\n')
    const dependent = await state.executeRun(session.id, dependentCode, {}, { session })
    assert.deepEqual(dependent.raw.value, [2, 3])
    assert.equal(dependent.result.meta.dshPtcPlus.status, 'volatile')
    appendRunCodeEvents(events, `${label}-dependent`, dependentCode, dependent.result)
    await state.dispose()

    const restored = fixture()
    t.after(() => restored.dispose())
    const coldResult = await restored.runDurable(
      session.id,
      'return [unconfirmedEditValue, typeof afterUnconfirmedEdit]',
      {},
      { session },
    )
    assert.equal(coldResult.isError, false, JSON.stringify(coldResult))
    assert.deepEqual(coldResult.value, [1, 'undefined'])
    appendRunCodeEvents(events, `${label}-cold`, 'return [unconfirmedEditValue, typeof afterUnconfirmedEdit]', coldResult)
    const boundaries = events.flatMap(event => event.data?.meta?.[RECOVERY_BOUNDARY_KEY] ?? [])
    assert.equal(boundaries.length, expectsRecoveryBoundary ? 1 : 0)
    if (expectsRecoveryBoundary) {
      assert.deepEqual(boundaries[0], { failedCallSeq: callSeq, frontierCallSeq: 1 })
    }
  }
})

test('carries derived recovery boundaries through the outer edit result', async (t) => {
  const events = []
  const session = appendOnlySession('derived-recovery-boundary', events)
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const requestSignal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal: requestSignal },
  )
  const setupCode = 'let derivedBoundaryValue = 1; return derivedBoundaryValue'
  const setup = await state.runDurable(session.id, setupCode, {}, { session })
  appendRunCodeEvents(events, 'derived-boundary-setup', setupCode, setup)
  appendEditCall(events, 'derived-boundary-edit', { edits: [{ old_string: '= 1', new_string: '= 2' }] })

  const originalExecute = state.ctx.tools.execute
  state.ctx.tools.execute = async options => {
    const result = await originalExecute(options)
    if (options.name !== 'run_code') return result
    return {
      ...result,
      meta: {
        ...result.meta,
        [RECOVERY_BOUNDARY_KEY]: [{ failedCallSeq: 9, frontierCallSeq: 1 }],
      },
    }
  }
  const edit = await state.ctx.tools.execute({
    callId: 'derived-boundary-edit',
    name: 'edit_run_code',
    arguments: { edits: [{ old_string: '= 1', new_string: '= 2' }] },
    agent,
    signal: requestSignal,
  })
  assert.equal(edit.isError, false, JSON.stringify(edit))
  assert.deepEqual(edit.meta[RECOVERY_BOUNDARY_KEY], [{ failedCallSeq: 9, frontierCallSeq: 1 }])
})
