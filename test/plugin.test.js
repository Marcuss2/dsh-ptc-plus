import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

function fixture(config = {}) {
  const listeners = new Map()
  const cleanups = []
  const sections = []
  const upstreamCalls = []
  let nextCallId = 0
  const runCodeDefinition = { output: {} }
  const runtime = {
    language: 'typescript',
    isolation: 'worker-thread',
    async run(request) {
      upstreamCalls.push(request)
      return { logs: ['upstream'], value: 'upstream' }
    },
  }
  const ctx = {
    codeRuntime: runtime,
    tools: { get: name => name === 'run_code' ? runCodeDefinition : undefined },
    systemPrompt: {
      section(value) {
        sections.push(value)
        return () => sections.splice(sections.indexOf(value), 1)
      },
    },
    on(name, listener) {
      const entries = listeners.get(name) ?? []
      entries.push(listener)
      listeners.set(name, entries)
      return () => entries.splice(entries.indexOf(listener), 1)
    },
    effect(register) {
      cleanups.push(register())
    },
  }
  apply(ctx, { computeMs: 500, maxWallMs: 2_000, ...config })

  async function executeRun(session, program, functions, options) {
    const execute = listeners.get('tools/execute')[0]
    const controller = options.controller ?? new AbortController()
    const exec = {
      name: 'run_code',
      callId: options.callId ?? `fixture-call-${++nextCallId}`,
      agent: { id: session, session: options.session },
    }
    let raw
    let result = await execute(exec, async () => {
      raw = await runtime.run({
        program,
        bindings: [{
          global: 'tools',
          functions,
          errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
        }],
        signal: controller.signal,
      })
      const meta = runCodeDefinition.output.presentationMeta?.({}, raw.value)
      if (raw.error) {
        return { isError: true, content: [], error: { message: raw.error.message }, meta }
      }
      return { isError: false, value: raw.value, content: [], meta }
    })
    if (options.finalizeResult !== undefined) result = options.finalizeResult(result)
    for (const listener of listeners.get('tools/result') ?? []) await listener(exec, result)
    return { raw, result }
  }

  async function run(session, program, functions = {}, options = {}) {
    return (await executeRun(session, program, functions, options)).raw
  }

  async function runDurable(session, program, functions = {}, options = {}) {
    return (await executeRun(session, program, functions, options)).result
  }

  async function rejectBeforeRuntime(session, options = {}) {
    const execute = listeners.get('tools/execute')[0]
    const exec = {
      name: 'run_code',
      callId: options.callId ?? `fixture-call-${++nextCallId}`,
      agent: { id: session, session: options.session },
    }
    let result = await execute(exec, async () => ({
      isError: true,
      content: [],
      error: { message: options.message ?? 'rejected before runtime dispatch' },
    }))
    if (options.finalizeResult !== undefined) result = options.finalizeResult(result)
    for (const listener of listeners.get('tools/result') ?? []) await listener(exec, result)
    return result
  }

  return {
    ctx,
    runtime,
    sections,
    upstreamCalls,
    rejectBeforeRuntime,
    runDurable,
    run,
    async emit(name, value) {
      await Promise.all((listeners.get(name) ?? []).map(listener => listener(value)))
    },
    async dispose() {
      for (const cleanup of cleanups.reverse()) await cleanup()
    },
  }
}

test('continues TypeScript bindings across cells in one session', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  assert.deepEqual(await state.run('session-a', `
const seed: number = 40
async function add(value: number): Promise<number> { return seed + value }
`), { logs: [] })
  assert.deepEqual(await state.run('session-a', 'return add(2)'), { logs: [], value: 42 })
})

test('tells the model to reuse the session REPL without adding tools', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  assert.equal(state.sections.length, 1)
  assert.equal(state.sections[0].name, 'tools:ptc-plus-repl')
  const guidance = state.sections[0].text({})
  assert.match(guidance, /session-bound REPL/)
  assert.match(guidance, /reuse bindings directly instead of resending source/)
  assert.match(guidance, /tools.*rebound/s)
  state.ctx.tools.get = () => undefined
  assert.equal(state.sections[0].text({}), '')
})

test('keeps REPL bindings isolated by session', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  await state.run('session-a', 'const privateValue = 7')
  assert.deepEqual(await state.run('session-a', 'return privateValue'), { logs: [], value: 7 })
  assert.deepEqual(await state.run('session-b', 'return typeof privateValue'), { logs: [], value: 'undefined' })
})

test('retains dynamic imports without repeating their source', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const imported = await state.runDurable('session-a', 'const { basename } = await import("node:path")')
  assert.equal(imported.meta.dshPtcPlus.status, 'volatile')
  assert.deepEqual(
    await state.run('session-a', 'return basename("C:/logs/session.jsonl.zstd")'),
    { logs: [], value: 'session.jsonl.zstd' },
  )
})

test('rebinds tools for old functions and expires captured tool closures', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  await state.run('session-a', `
async function currentValue() { return tools.value({}) }
const staleValue = tools.value
`, { value: async () => 1 })

  assert.deepEqual(
    await state.run('session-a', 'return currentValue()', { value: async () => 2 }),
    { logs: [], value: 2 },
  )
  assert.deepEqual(
    await state.run('session-a', 'return currentValue()', { value: async () => 3 }),
    { logs: [], value: 3 },
  )

  const expired = await state.run('session-a', `
let expiredMessage
try { await staleValue({}) } catch (error) { expiredMessage = error.message }
return expiredMessage
`, { value: async () => 4 })
  assert.deepEqual(expired, { logs: [], value: 'PTC execution lease expired' })
})

test('materializes binding failures as the declared tool error class', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const result = await state.run('session-a', `
let caught
try { await tools.fail({}) } catch (error) {
  caught = { name: error.name, toolName: error.toolName, message: error.message }
}
return caught
`, { fail: async () => { throw new Error('denied') } })
  assert.deepEqual(result, {
    logs: [],
    value: { name: 'ToolCallError', toolName: 'fail', message: 'denied' },
  })
})

test('captures console output and returns only explicit cell output', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  assert.deepEqual(await state.run('session-a', `
const internal = 21 * 2
console.log("answer", internal)
process.stdout.write("raw output\\n")
return { answer: internal }
`), { logs: ['answer 42', 'raw output\n'], value: { answer: 42 } })
})

test('enforces the output budget before a cell can flood the host', async (t) => {
  const state = fixture({ maxOutputBytes: 64 })
  t.after(() => state.dispose())
  const result = await state.run('session-a', `
for (let index = 0; index < 1000; index += 1) console.log("xxxxxxxxxxxxxxxx")
`)
  assert.equal(result.error.kind, 'output-limit')
  assert.ok(result.logs.length < 10)
})

test('preserves function-body return semantics across control flow', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.run('session-a', `
function nested(value) {
  if (value) return 10
  return 20
}
let finalized = false
`)

  assert.deepEqual(await state.run('session-a', `
try {
  if (true) return nested(true)
} catch (error) {
  return 99
} finally {
  finalized = true
}
`), { logs: [], value: 10 })
  assert.deepEqual(await state.run('session-a', 'return finalized'), { logs: [], value: true })

  assert.deepEqual(await state.run('session-a', `
try { throw new Error("ordinary") } catch { return 4 }
`), { logs: [], value: 4 })
})

test('reports runtime exceptions and invalid output without hanging the kernel', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const thrown = await state.run('session-a', 'throw new Error("boom")')
  assert.equal(thrown.error.kind, 'exception')
  assert.match(thrown.error.message, /boom/)

  const invalid = await state.run('session-a', 'return () => 1')
  assert.equal(invalid.error.kind, 'invalid-output')
  assert.match(invalid.error.message, /not lossless JSON/)
  assert.deepEqual(await state.run('session-a', 'return 6'), { logs: [], value: 6 })
})

test('matches the lossless-JSON boundary for shared and exotic values', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const shared = await state.run('session-a', `
const sharedItem = { value: 1 }
return [sharedItem, sharedItem]
`)
  assert.deepEqual(shared, { logs: [], value: [{ value: 1 }, { value: 1 }] })
  assert.notEqual(shared.value[0], shared.value[1])

  for (const source of [
    'return -0',
    'return new Date(0)',
    'const value = {}; value[Symbol("x")] = 1; return value',
    'const value = []; value.extra = 1; return value',
  ]) {
    const result = await state.run(`invalid-${source.length}`, source)
    assert.ok(['invalid-output', 'exception'].includes(result.error.kind))
  }
})

test('preserves Math intrinsics and harmless local ambient names as durable', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const math = await state.runDurable('math-intrinsics', 'return [Math.max(1, 2), Math.PI]')
  assert.deepEqual(math.value, [2, Math.PI])
  assert.equal(math.meta.dshPtcPlus.status, 'durable')

  const local = await state.runDurable('local-ambient-name', `
function readLocal(Date) { return { Date, value: Date + 1 } }
return readLocal(4)
`)
  assert.deepEqual(local.value, { Date: 4, value: 5 })
  assert.equal(local.meta.dshPtcPlus.status, 'durable')
})

test('keeps non-journalable Node capabilities live in a volatile suffix', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const imported = await state.runDurable('volatile-node', `
const fsModule = await import("node:fs")
return typeof fsModule.readFileSync
`)
  assert.equal(imported.value, 'function')
  assert.equal(imported.meta.dshPtcPlus.status, 'volatile')
  assert.deepEqual(await state.run('volatile-node', 'return typeof fsModule.readFileSync'), {
    logs: [],
    value: 'function',
  })
})

test('rejects kernel-control modules through the global require view', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const result = await state.run('session-a', 'return globalThis.require("node:worker_threads")')
  assert.equal(result.error.kind, 'exception')
  assert.match(result.error.message, /forbidden because it exposes kernel control/)
})

test('rejects non-replayable worker control imports', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const result = await state.run('session-a', `
const { parentPort } = await import("node:worker_threads")
parentPort.postMessage({ type: "done", id: 1, logs: [], value: [999] })
parentPort.postMessage({ type: "call", runId: 1, id: 1, global: "tools", member: "forged", args: [null] })
return 42
`, { forged: async () => { throw new Error('public parentPort reached host protocol') } })
  assert.equal(result.error.kind, 'exception')
  assert.match(result.error.message, /forbidden because it exposes kernel control/)

  const alias = await state.run('session-b', 'return import("worker_threads")')
  assert.equal(alias.error.kind, 'exception')
  assert.match(alias.error.message, /forbidden because it exposes kernel control/)
})

test('does not replay a volatile cell after a cold restore', async (t) => {
  const events = []
  const session = { id: 'session-rejected', events }
  const first = fixture()
  t.after(() => first.dispose())
  const code = 'const shouldNeverExist = Date.now()'
  const rejected = await first.runDurable('session-rejected', code, {}, { session })
  assert.equal(rejected.isError, false)
  assert.equal(rejected.meta.dshPtcPlus.status, 'volatile')
  appendRunCodeEvents(events, 'call-rejected', code, rejected)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  const result = await restored.run('session-rejected', 'return typeof shouldNeverExist', {}, { session })
  assert.equal(result.value, 'undefined')
  assert.match(result.logs[0], /volatile or unconfirmed cell/)
})

test('recovers the last durable frontier when a run_code journal is missing', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const session = {
    id: 'session-incomplete',
    events: [{
      type: 'tool/call',
      seq: 0,
      time: 0,
      data: {
        turn: 0,
        step: 0,
        callId: 'old-call',
        name: 'run_code',
        arguments: JSON.stringify({ code: 'const lost = 1', description: 'old cell' }),
      },
    }],
  }
  const result = await state.run('session-incomplete', 'return 1', {}, { session })
  assert.equal(result.value, 1)
  assert.match(result.logs[0], /volatile or unconfirmed cell/)
})

test('advances durability again after recovering an unknown suffix', async (t) => {
  const events = [{
    type: 'tool/call',
    seq: 0,
    time: 0,
    data: {
      turn: 0,
      step: 0,
      callId: 'unknown-call',
      name: 'run_code',
      arguments: JSON.stringify({ code: 'const unknownBinding = 1', description: 'unknown cell' }),
    },
  }]
  const session = { id: 'session-rebased', events }
  const first = fixture()
  t.after(() => first.dispose())
  const rebasedCode = `
const rebasedBinding = 2
void await repl.state({ action: 'save', name: 'rebased' })
`
  const rebased = await first.runDurable(session.id, rebasedCode, {}, { session })
  assert.equal(rebased.meta.dshPtcPlus.status, 'durable')
  appendRunCodeEvents(events, 'rebased-call', rebasedCode, rebased)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  const result = await restored.run(session.id, `
const states = await repl.state({ action: 'list' })
return { unknown: typeof unknownBinding, rebasedBinding, names: states.names }
`, {}, { session })
  assert.deepEqual(result, {
    logs: [],
    value: { unknown: 'undefined', rebasedBinding: 2, names: ['rebased'] },
  })
})

test('preserves deeply nested JSON and own __proto__ keys', async (t) => {
  const state = fixture({ maxOutputBytes: 4 * 1024 * 1024 })
  t.after(() => state.dispose())

  const proto = await state.run('session-a', 'return JSON.parse(\'{"__proto__":{"safe":true}}\')')
  assert.equal(Object.hasOwn(proto.value, '__proto__'), true)
  assert.deepEqual(proto.value.__proto__, { safe: true })
  assert.equal(Object.getPrototypeOf(proto.value), Object.prototype)

  await state.run('session-a', `
let deep = "leaf"
for (let index = 0; index < 5000; index += 1) deep = [deep]
`)
  const result = await state.run('session-a', 'return deep')
  let cursor = result.value
  let depth = 0
  while (Array.isArray(cursor)) { cursor = cursor[0]; depth += 1 }
  assert.equal(depth, 5_000)
  assert.equal(cursor, 'leaf')
})

test('compares persisted journals with deeply nested tool arguments iteratively', async (t) => {
  const state = fixture({ maxOutputBytes: 4 * 1024 * 1024 })
  t.after(() => state.dispose())
  const result = await state.runDurable('deep-journal', `
let nestedArgument = "leaf"
for (let index = 0; index < 5000; index += 1) nestedArgument = [nestedArgument]
return await tools.measureDepth({ value: nestedArgument })
`, {
    measureDepth: async ({ value }) => {
      let cursor = value
      let depth = 0
      while (Array.isArray(cursor)) { cursor = cursor[0]; depth += 1 }
      return { depth, leaf: cursor }
    },
  })
  assert.deepEqual(result.value, { depth: 5_000, leaf: 'leaf' })
  assert.equal(result.meta.dshPtcPlus.status, 'durable')
})

test('hard cancellation restores the previous durable frontier', async (t) => {
  const state = fixture({ computeMs: 1_000, maxWallMs: 2_000 })
  t.after(() => state.dispose())
  await state.run('session-a', 'const beforeAbort = 1')

  const controller = new AbortController()
  const pending = state.run('session-a', 'for (;;) {}', {}, { controller })
  setTimeout(() => controller.abort('stop requested'), 30)
  assert.deepEqual(await pending, {
    logs: [],
    error: { kind: 'abort', message: 'stop requested' },
  })
  assert.deepEqual(await state.run('session-a', 'return typeof beforeAbort'), {
    logs: [],
    value: 'number',
  })
})

test('attributes inherited async callbacks to the currently active cell', async (t) => {
  const events = []
  const session = { id: 'async-volatility', events }
  const first = fixture()
  t.after(() => first.dispose())
  const setupCode = `
let asyncValue = 0
let releaseAsyncValue
const deferredAsyncValue = new Promise(resolve => { releaseAsyncValue = resolve })
void deferredAsyncValue.then(() => { asyncValue = Math['ran' + 'dom']() })
`
  const setup = await first.runDurable(session.id, setupCode, {}, { session })
  assert.equal(setup.meta.dshPtcPlus.status, 'durable')
  appendRunCodeEvents(events, 'async-setup', setupCode, setup)

  const triggerCode = `
releaseAsyncValue()
await Promise.resolve()
return asyncValue
`
  const triggered = await first.runDurable(session.id, triggerCode, {}, { session })
  assert.equal(typeof triggered.value, 'number')
  assert.equal(triggered.meta.dshPtcPlus.status, 'volatile')
  appendRunCodeEvents(events, 'async-trigger', triggerCode, triggered)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  const result = await restored.run(session.id, 'return asyncValue', {}, { session })
  assert.equal(result.value, 0)
  assert.match(result.logs[0], /volatile or unconfirmed cell/)
})

test('keeps result and error conversion inside the active execution', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const returned = await state.runDurable('result-conversion-volatility', `
let resultConversionState = 0
return {
  get value() {
    resultConversionState = Math['ran' + 'dom']()
    return resultConversionState
  }
}
`)
  assert.equal(typeof returned.value.value, 'number')
  assert.equal(returned.meta.dshPtcPlus.status, 'volatile')
  assert.equal(returned.meta.dshPtcPlus.volatileReason, 'Math.random')

  const thrown = await state.runDurable('error-conversion-volatility', `
throw {
  toString() {
    void Math['ran' + 'dom']()
    return 'converted failure'
  }
}
`)
  assert.equal(thrown.isError, true)
  assert.equal(thrown.error.message, 'converted failure')
  assert.equal(thrown.meta.dshPtcPlus.status, 'volatile')
  assert.equal(thrown.meta.dshPtcPlus.volatileReason, 'Math.random')
})

test('does not lose cancellation during cold worker startup', async (t) => {
  const state = fixture({ computeMs: 1_000, maxWallMs: 2_000 })
  t.after(() => state.dispose())
  const controller = new AbortController()
  const pending = state.run('cold-abort', 'const coldBinding = 1', {}, { controller })
  controller.abort('cancelled during startup')
  assert.deepEqual(await pending, {
    logs: [],
    error: { kind: 'abort', message: 'cancelled during startup' },
  })
  assert.deepEqual(await state.run('cold-abort', 'return typeof coldBinding'), {
    logs: [],
    value: 'undefined',
  })
})

test('clears incomplete host calls from a discarded journal', async (t) => {
  const state = fixture({ computeMs: 1_000, maxWallMs: 2_000 })
  t.after(() => state.dispose())
  await state.run('pending-call-abort', 'const durableBeforePendingCall = 1')

  let signalStarted
  const started = new Promise(resolve => { signalStarted = resolve })
  const controller = new AbortController()
  const pending = state.runDurable('pending-call-abort', 'await tools.neverSettles({})', {
    neverSettles: async () => {
      signalStarted()
      return new Promise(() => {})
    },
  }, { controller })
  await started
  controller.abort('stop pending host call')
  const result = await pending
  assert.equal(result.isError, true)
  assert.equal(result.meta.dshPtcPlus.status, 'discarded')
  assert.deepEqual(result.meta.dshPtcPlus.calls, [])
  assert.deepEqual(await state.run('pending-call-abort', 'return durableBeforePendingCall'), {
    logs: [],
    value: 1,
  })
})

function appendRunCodeEvents(events, callId, code, result) {
  const callSeq = events.length
  events.push({
    type: 'tool/call',
    seq: callSeq,
    time: callSeq,
    data: {
      turn: 0,
      step: 0,
      callId,
      name: 'run_code',
      arguments: JSON.stringify({ code, description: 'test cell' }),
    },
  })
  events.push({
    type: 'tool/result',
    seq: callSeq + 1,
    time: callSeq + 1,
    sourceEventSeqs: [callSeq],
    surfaceOp: 'append',
    data: {
      message: {
        id: `message-${callId}`,
        role: 'tool',
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [] }],
      },
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    },
  })
}

test('treats post-execute metadata removal as a volatile boundary', async (t) => {
  const events = []
  const session = { id: 'session-post-strip', events }
  const first = fixture()
  t.after(() => first.dispose())

  const durableCode = 'const durableValue = 40'
  const durable = await first.runDurable(session.id, durableCode, {}, { session })
  appendRunCodeEvents(events, 'durable-call', durableCode, durable)

  const strippedCode = 'const strippedValue = 2'
  const stripped = await first.runDurable(session.id, strippedCode, {}, {
    session,
    finalizeResult(result) {
      const { meta: _removed, ...withoutMeta } = result
      return withoutMeta
    },
  })
  assert.equal(stripped.meta, undefined)
  appendRunCodeEvents(events, 'stripped-call', strippedCode, stripped)
  assert.deepEqual(await first.run(session.id, 'return durableValue + strippedValue'), {
    logs: [],
    value: 42,
  })
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  const result = await restored.run(session.id, `
return { durableValue, strippedType: typeof strippedValue }
`, {}, { session })
  assert.deepEqual(result.value, { durableValue: 40, strippedType: 'undefined' })
  assert.match(result.logs[0], /volatile or unconfirmed cell/)
})

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
            version: 1,
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
      return { ...result, meta: { ...result.meta, dshPtcPlus: { version: 1 } } }
    },
  })
  assert.deepEqual(corrupt.meta.dshPtcPlus, { version: 1 })
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
})

test('confirms pre-dispatch no-ops in the next durable journal', async (t) => {
  const events = []
  const session = { id: 'session-confirm-noop', events }
  const first = fixture()
  t.after(() => first.dispose())

  const rejectedCode = 'const rejectedBinding = 1'
  const rejected = await first.rejectBeforeRuntime(session.id, {
    callId: 'pre-denied-call',
    session,
  })
  appendRunCodeEvents(events, 'pre-denied-call', rejectedCode, rejected)

  const durableCode = 'const acceptedBinding = 2'
  const durable = await first.runDurable(session.id, durableCode, {}, { session })
  assert.deepEqual(durable.meta.dshPtcPlus.confirms, ['pre-denied-call'])
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

test('replays concurrent host calls in their recorded settlement order', async (t) => {
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
`), { logs: [], value: { names: [] } })
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

test('fails recovery when replay hits an infrastructure timeout', async (t) => {
  const state = fixture({ computeMs: 20, maxWallMs: 1_000 })
  t.after(() => state.dispose())
  const session = { id: 'replay-timeout', events: [] }
  appendRunCodeEvents(session.events, 'timed-out-history', 'for (;;) {}', {
    meta: {
      dshPtcPlus: {
        version: 1,
        status: 'durable',
        calls: [],
        operations: [],
        confirms: [],
        completion: {
          kind: 'throw',
          error: { kind: 'timeout', message: 'recorded timeout' },
        },
      },
    },
  })

  const result = await state.run(session.id, 'return 1', {}, { session })
  assert.equal(result.error.kind, 'recovery')
  assert.match(result.error.message, /infrastructure failed \(timeout\)/)
})

test('disposes a kernel with its owning agent session', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.run('session-a', 'const sessionValue = 9')

  await state.emit('agent/disposed', { agent: { id: 'session-a' } })
  assert.deepEqual(await state.run('session-a', 'return typeof sessionValue'), {
    logs: [],
    value: 'undefined',
  })
})

test('delegates non-agent runtime calls and restores the provider on teardown', async () => {
  const state = fixture()
  const patched = state.runtime.run
  assert.deepEqual(await state.runtime.run({ program: 'return 1', bindings: [] }), {
    logs: ['upstream'],
    value: 'upstream',
  })
  assert.equal(state.upstreamCalls.length, 1)

  await state.dispose()
  assert.notEqual(state.runtime.run, patched)
  assert.deepEqual(await state.runtime.run({ program: 'return 2', bindings: [] }), {
    logs: ['upstream'],
    value: 'upstream',
  })
})

test('rejects unsupported runtimes and invalid limits', () => {
  const base = {
    tools: {},
    systemPrompt: { section() {} },
    on() {},
    effect() {},
  }
  assert.throws(() => apply({ ...base, codeRuntime: { language: 'python' } }), /only "typescript" is supported/)
  assert.throws(() => apply({
    ...base,
    codeRuntime: { language: 'typescript', run() {} },
  }, { maxWallMs: 0 }), /maxWallMs must be a positive safe integer/)
  assert.throws(() => apply({
    ...base,
    codeRuntime: { language: 'typescript', run() {} },
  }, { maxWallMs: 2_147_483_648 }), /maxWallMs must not exceed/)
})
