import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'
import { normalizeJournal } from '../internal/session-journal.js'

function fixture(config = {}, fixtureOptions = {}) {
  const listeners = new Map()
  const cleanups = []
  const sections = []
  const upstreamCalls = []
  let nextCallId = 0
  const runCodeDefinition = {
    name: 'run_code',
    description: 'Execute one standalone program.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', description: 'Standalone program source.' },
        description: { type: 'string', description: 'Program summary.' },
      },
      required: ['code', 'description'],
    },
    output: {},
  }
  const runtime = {
    language: 'typescript',
    isolation: 'worker-thread',
    async run(request) {
      upstreamCalls.push(request)
      if (fixtureOptions.upstreamRun !== undefined) return fixtureOptions.upstreamRun(request)
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

  async function assemble(assembly, context = {}, next = async () => assembly) {
    const listener = listeners.get('system-prompt/assemble')?.[0]
    return listener === undefined ? next() : listener(assembly, context, next)
  }

  async function dispatchNestedRun(session, args, options = {}) {
    const execute = listeners.get('tools/execute')[0]
    const controller = options.controller ?? new AbortController()
    const exec = {
      name: 'run_code',
      callId: options.callId ?? `fixture-nested-${++nextCallId}`,
      rootCallId: options.rootCallId ?? 'fixture-root',
      parent: options.parent ?? { id: 'fixture-parent-token' },
      agent: { id: session, session: options.session },
    }
    let result = await execute(exec, async () => {
      const raw = await runtime.run({ program: args.code, bindings: options.bindings ?? [], signal: controller.signal })
      if (raw.error !== undefined) {
        return { isError: true, content: [], error: { message: raw.error.message } }
      }
      return {
        isError: false,
        content: [],
        value: { logs: raw.logs, ...(raw.value === undefined ? {} : { result: raw.value }) },
      }
    })
    if (options.finalizeResult !== undefined) result = options.finalizeResult(result)
    for (const listener of listeners.get('tools/result') ?? []) await listener(exec, result)
    return result
  }

  return {
    ctx,
    runtime,
    runCodeDefinition,
    sections,
    upstreamCalls,
    assemble,
    dispatchNestedRun,
    executeRun,
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

test('evaluates complete block cells with awaited lexical initializers', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const source = `{
  const awaitedConst = await Promise.resolve(19)
  let awaitedLet = await Promise.resolve(20)
  let nestedResult = 0
  {
    const { value: nestedValue } = await Promise.resolve({ value: 3 })
    nestedResult = nestedValue
  }
  if (awaitedConst + awaitedLet + nestedResult !== 42) throw new Error('incorrect block result')
}
// framing remains outside this trailing comment`
  const observed = await state.executeRun('block-await', source, {}, {})
  assert.deepEqual(observed.raw, { logs: [] })
  assert.equal(observed.result.meta.dshPtcPlus.status, 'durable')
  assert.deepEqual(await state.run('block-await', `
"use strict";
{
  const strictThis = (function () { return this })()
  const strictOk = await Promise.resolve(strictThis === undefined)
  if (!strictOk) throw new Error('directive prologue was not preserved')
}
return [typeof __ptc_canary, typeof awaitedConst, typeof awaitedLet, typeof nestedResult, typeof nestedValue]
`), { logs: [], value: ['undefined', 'undefined', 'undefined', 'undefined', 'undefined'] })
})

test('cold-replays a block-scoped awaited initializer without source conventions', async (t) => {
  const events = []
  const session = { id: 'block-await-replay', events }
  const first = fixture()
  t.after(() => first.dispose())

  const setupCode = 'let blockAwaitReplayValue = 0'
  const setup = await first.runDurable(session.id, setupCode, {}, { session })
  appendRunCodeEvents(events, 'block-await-setup', setupCode, setup)
  const blockCode = `{
  const nextValue = await Promise.resolve(42)
  blockAwaitReplayValue = nextValue
}
// no model-side semicolon`
  const block = await first.runDurable(session.id, blockCode, {}, { session })
  assert.equal(block.meta.dshPtcPlus.status, 'durable')
  appendRunCodeEvents(events, 'block-await-cell', blockCode, block)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, 'return blockAwaitReplayValue', {}, { session }), {
    logs: [],
    value: 42,
  })
})

test('presents one coherent persistent REPL contract to the model', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  assert.equal(state.sections.length, 1)
  assert.equal(state.sections[0].name, 'tools:ptc-plus-repl')
  assert.equal(state.sections[0].order, 98)
  const guidance = state.sections[0].text({})
  assert.equal(
    guidance.split('\n')[0],
    '`run_code` evaluates consecutive top-level cells in one session-bound persistent REPL.',
  )
  assert.match(guidance, /session-bound REPL/)
  assert.match(guidance, /Reuse existing top-level bindings and do not resend setup source/)
  assert.match(guidance, /Redeclaring an existing top-level name fails before execution/)
  assert.match(guidance, /Direct non-journalable Node\/process access changes only cold recovery/)
  assert.match(guidance, /Follow `\[PTC-\.\.\.\]` `help:` lines and retry only the failing part/)
  assert.match(guidance, /tools\.run_code\(\{ code, description \}\).*returns `\{ logs, result\? \}`/)
  assert.match(guidance, /historical source may be read through available session-event tools/i)
  state.ctx.tools.get = () => undefined
  assert.equal(state.sections[0].text({}), '')
})

test('immutably adapts only the model-visible run_code schema wording', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const runCode = {
    name: 'run_code',
    description: 'Execute one standalone program.',
    annotation: { retained: true },
    parameters: {
      type: 'object',
      additionalProperties: false,
      comment: 'retained',
      properties: {
        code: { type: 'string', description: 'Standalone source.', minLength: 0 },
        description: { type: 'string', description: 'Program summary.', maxLength: 80 },
      },
      required: ['code', 'description'],
    },
  }
  const original = structuredClone(runCode)
  const other = { name: 'other', description: 'Other tool.', parameters: { type: 'object', properties: {} } }
  const initial = { sections: [], contexts: [], tools: [], variables: {} }
  const downstream = { sections: [{ name: 'later', text: 'kept' }], contexts: [], tools: [other, runCode], variables: { kept: 'yes' } }
  const adapted = await state.assemble(initial, {}, async () => downstream)

  assert.notEqual(adapted, downstream)
  assert.deepEqual(runCode, original)
  assert.equal(adapted.sections, downstream.sections)
  assert.equal(adapted.contexts, downstream.contexts)
  assert.equal(adapted.variables, downstream.variables)
  assert.equal(adapted.tools[0], other)
  assert.equal(adapted.tools[1].name, 'run_code')
  assert.match(adapted.tools[1].description, /next TypeScript cell.*persistent REPL/)
  assert.equal(adapted.tools[1].parameters.properties.code.description,
    'Code for the next REPL cell, parsed as the body of an async TypeScript function.')
  assert.equal(adapted.tools[1].parameters.properties.description.description,
    'Short active-voice summary of what this cell does, 5-10 words (shown in the UI).')
  assert.deepEqual(adapted.tools[1].annotation, { retained: true })
  assert.equal(adapted.tools[1].parameters.additionalProperties, false)
  assert.equal(adapted.tools[1].parameters.comment, 'retained')
  assert.deepEqual(adapted.tools[1].parameters.required, ['code', 'description'])
  assert.equal(adapted.tools[1].parameters.properties.code.minLength, 0)
  assert.equal(adapted.tools[1].parameters.properties.description.maxLength, 80)
})

test('leaves absent run_code assemblies unchanged and rejects incompatible schemas', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const assembly = {
    sections: [], contexts: [], variables: {},
    tools: [{ name: 'other', description: 'Other.', parameters: { type: 'object', properties: {} } }],
  }
  assert.equal(await state.assemble(assembly), assembly)
  await assert.rejects(state.assemble({
    ...assembly,
    tools: [{
      name: 'run_code',
      description: 'Wrong.',
      parameters: { type: 'object', properties: { code: { type: 'string' } } },
    }],
  }), /ptc-plus: incompatible run_code schema/)
})

test('accepts only the single current journal schema', () => {
  assert.throws(() => normalizeJournal({
    version: 1,
    status: 'durable',
    calls: [],
    operations: [],
    confirms: [],
    completion: { kind: 'return' },
  }), /invalid dsh-ptc-plus journal diagnostics/)
})

test('preflights every cross-cell binding collision with one actionable diagnostic', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  await state.runDurable('collision-diagnostic', 'let executed = 0\nconst fs = 1\nconst base = 2')
  const source = 'executed += 1\nconst fs = 3\nconst base = 4'
  const observed = await state.executeRun('collision-diagnostic', source, {}, {})
  const text = [
    'error[PTC-N001]: top-level bindings already exist: fs, base. This cell was not executed; the REPL state is unchanged.',
    ' --> current:2:7',
    '> 2 | const fs = 3',
    '    |       ^^',
    'phase: preflight',
    'state: unchanged',
    'help: reuse the existing bindings',
    'help: place one-off declarations inside a block',
  ].join('\n')

  assert.deepEqual(observed.raw, { logs: [text], error: { kind: 'exception', message: text } })
  assert.equal(observed.result.meta.dshPtcPlus.status, 'noop')
  assert.deepEqual(observed.result.meta.dshPtcPlus.diagnostics, [{
    code: 'PTC-N001',
    severity: 'error',
    phase: 'preflight',
    message: 'top-level bindings already exist: fs, base. This cell was not executed; the REPL state is unchanged.',
    stateEffect: 'unchanged',
    source: {
      cell: 'current',
      start: { line: 2, column: 7 },
      end: { line: 2, column: 9 },
    },
    help: ['reuse the existing bindings', 'place one-off declarations inside a block'],
  }])
  assert.deepEqual(await state.run('collision-diagnostic', 'return { executed, fs, base }'), {
    logs: [],
    value: { executed: 0, fs: 1, base: 2 },
  })
})

test('renders parse failures with a cell-relative code frame and unchanged state', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const observed = await state.executeRun('parse-diagnostic', 'const value =', {}, {})
  const diagnostic = observed.result.meta.dshPtcPlus.diagnostics[0]
  assert.equal(observed.result.meta.dshPtcPlus.status, 'noop')
  assert.equal(diagnostic.code, 'PTC-C001')
  assert.equal(diagnostic.phase, 'parse')
  assert.equal(diagnostic.stateEffect, 'unchanged')
  assert.deepEqual(diagnostic.source, { cell: 'current', start: { line: 1, column: 14 } })
  assert.equal(observed.raw.error.message, observed.raw.logs[0])
  assert.match(observed.raw.error.message, /^error\[PTC-C001\]: cell could not be parsed:/)
  assert.match(observed.raw.error.message, /> 1 \| const value =\n    \|              \^/)
  assert.doesNotMatch(observed.raw.error.message, /\x1b\[/)
  assert.deepEqual(await state.run('parse-diagnostic', 'return typeof value'), {
    logs: [],
    value: 'undefined',
  })
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

test('injects tools.run_code and routes it to the isolated upstream runtime', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const childCode = 'const childOnly = 1; return childOnly'
  const functions = { read: async () => 'visible' }

  const observed = await state.executeRun('recursive-isolation', `
const parentOnly = 41
const nestedOutcome = await tools.run_code({
  code: ${JSON.stringify(childCode)},
  description: 'Execute isolated child code',
})
return { parentOnly, nestedOutcome }
`, functions, {})

  assert.deepEqual(observed.raw, {
    logs: [],
    value: { parentOnly: 41, nestedOutcome: { logs: ['upstream'], result: 'upstream' } },
  })
  assert.equal(state.upstreamCalls.length, 1)
  assert.equal(state.upstreamCalls[0].program, childCode)
  assert.equal(state.upstreamCalls[0].signal instanceof AbortSignal, true)
  const childTools = state.upstreamCalls[0].bindings.find(binding => binding.global === 'tools')
  assert.equal(childTools.functions.read, functions.read)
  assert.equal(typeof childTools.functions.run_code, 'function')
  assert.equal(Object.hasOwn(functions, 'run_code'), false)
  assert.equal(observed.result.meta.dshPtcPlus.status, 'durable')
  assert.deepEqual(observed.result.meta.dshPtcPlus.calls.map(call => [call.global, call.member]), [
    ['tools', 'run_code'],
  ])
  assert.deepEqual(await state.run('recursive-isolation', `
return { parentOnly, childOnly: typeof childOnly }
`), { logs: [], value: { parentOnly: 41, childOnly: 'undefined' } })
})

test('preserves an existing host run_code binding', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const hostRunCode = async args => {
    const result = await state.dispatchNestedRun('host-recursion', args)
    if (result.isError) throw new Error(result.error.message)
    return result.value
  }

  assert.deepEqual(await state.run('host-recursion', `
return tools.run_code({ code: 'return 1', description: 'Use host recursion' })
`, { run_code: hostRunCode }), {
    logs: [],
    value: { logs: ['upstream'], result: 'upstream' },
  })
  assert.equal(state.upstreamCalls.length, 1)
})

test('supports bounded recursive run_code and leaves the parent usable after overflow', async (t) => {
  const state = fixture({ maxNestedRunCodeDepth: 2 }, {
    async upstreamRun(request) {
      const remaining = Number(request.program)
      if (remaining === 0) return { logs: ['leaf'], value: 0 }
      const runCode = request.bindings.find(binding => binding.global === 'tools').functions.run_code
      try {
        const result = await runCode({
          code: String(remaining - 1),
          description: 'Continue recursive evaluation',
        })
        return { logs: [], value: result }
      } catch (error) {
        return { logs: [], error: { kind: 'exception', message: error.message } }
      }
    },
  })
  t.after(() => state.dispose())

  assert.deepEqual(await state.run('recursive-depth-ok', `
return tools.run_code({ code: '1', description: 'Evaluate two child levels' })
`), {
    logs: [],
    value: { logs: [], result: { logs: ['leaf'], result: 0 } },
  })

  const overflow = await state.run('recursive-depth-overflow', `
return tools.run_code({ code: '2', description: 'Exceed child depth limit' })
`)
  assert.equal(overflow.error.kind, 'exception')
  assert.match(overflow.error.message, /recursion depth exceeds configured maximum 2/)
  assert.deepEqual(await state.run('recursive-depth-overflow', 'return 42'), { logs: [], value: 42 })
})

test('validates nested run_code arguments as a closed object', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const result = await state.run('recursive-arguments', `
let message
try {
  await tools.run_code({ code: 'return 1', description: 'Reject extra input', extra: true })
} catch (error) {
  message = error.message
}
return message
`)
  assert.match(result.value, /expects exactly code and description string properties/)
  assert.equal(state.upstreamCalls.length, 0)
})

test('turns child runtime failure into a normal binding error and keeps the parent usable', async (t) => {
  const controller = new AbortController()
  const state = fixture({}, {
    async upstreamRun(request) {
      assert.equal(request.signal, controller.signal)
      return { logs: ['child log'], error: { kind: 'timeout', message: 'child budget exhausted' } }
    },
  })
  t.after(() => state.dispose())

  const result = await state.run('recursive-child-failure', `
let childFailure
try {
  await tools.run_code({ code: 'for (;;) {}', description: 'Reach child timeout' })
} catch (error) {
  childFailure = { name: error.name, toolName: error.toolName, message: error.message }
}
return childFailure
`, {}, { controller })
  assert.deepEqual(result, {
    logs: [],
    value: {
      name: 'ToolCallError',
      toolName: 'run_code',
      message: 'nested run_code failed (timeout): child budget exhausted',
    },
  })
  assert.deepEqual(await state.run('recursive-child-failure', 'return 42'), { logs: [], value: 42 })
})

test('cold-replays a nested run_code result without dispatching the child again', async (t) => {
  const events = []
  const session = { id: 'recursive-replay', events }
  const first = fixture()
  t.after(() => first.dispose())
  const code = `const recursiveReplayResult = await tools.run_code({
  code: 'return 42',
  description: 'Compute isolated child value',
})`
  const recorded = await first.runDurable(session.id, code, {}, { session })
  assert.equal(first.upstreamCalls.length, 1)
  assert.equal(recorded.meta.dshPtcPlus.calls[0].member, 'run_code')
  appendRunCodeEvents(events, 'recursive-parent', code, recorded)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  const result = await restored.run(session.id, 'return recursiveReplayResult', {}, { session })
  assert.deepEqual(result, { logs: [], value: { logs: ['upstream'], result: 'upstream' } })
  assert.equal(restored.upstreamCalls.length, 0)
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

test('preserves available host error codes as a structured diagnostic cause', async (t) => {
  const events = []
  const session = { id: 'host-cause', events }
  const state = fixture()
  t.after(() => state.dispose())

  const code = 'return await tools.read({ path: "missing" })'
  const observed = await state.executeRun(session.id, code, {
    read: async () => {
      const error = new Error('file not found')
      error.code = 'ENOENT'
      throw error
    },
  }, { session })
  const diagnostic = observed.result.meta.dshPtcPlus.diagnostics[0]
  assert.equal(diagnostic.code, 'PTC-X001')
  assert.deepEqual(diagnostic.cause, { code: 'ENOENT', message: 'file not found' })
  assert.match(observed.raw.error.message, /cause: ENOENT: file not found/)
  assert.equal(Object.hasOwn(diagnostic, 'dispatchState'), false)
  appendRunCodeEvents(events, 'host-cause-call', code, observed.result)
  await state.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  let replayedCalls = 0
  const recovered = await restored.run(session.id, 'return 42', {
    read: async () => {
      replayedCalls += 1
      throw new Error('host call was repeated')
    },
  }, { session })
  assert.deepEqual(recovered, { logs: [], value: 42 })
  assert.equal(replayedCalls, 0)
})

test('ignores throwing diagnostic accessors on host errors', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const observed = await state.executeRun('host-hostile-error', 'return await tools.fail({})', {
    fail: async () => {
      const error = new Error('original host failure')
      Object.defineProperties(error, {
        diagnostic: { get() { throw new Error('diagnostic getter escaped') } },
        cause: { get() { throw new Error('cause getter escaped') } },
      })
      throw error
    },
  }, {})
  assert.equal(observed.result.meta.dshPtcPlus.diagnostics[0].code, 'PTC-X001')
  assert.deepEqual(observed.result.meta.dshPtcPlus.diagnostics[0].cause, {
    message: 'original host failure',
  })
  assert.match(observed.raw.error.message, /cause: original host failure/)
  assert.deepEqual(await state.run('host-hostile-error', 'return 42'), { logs: [], value: 42 })
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

test('reports runtime exceptions as partially applied and preserves earlier mutations', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  await state.runDurable('runtime-diagnostic', 'let value = 0')
  const observed = await state.executeRun(
    'runtime-diagnostic',
    'value = 1\nthrow new TypeError("value.trim is not a function")',
    {},
    {},
  )
  const diagnostic = observed.result.meta.dshPtcPlus.diagnostics[0]
  assert.equal(diagnostic.code, 'PTC-X001')
  assert.equal(diagnostic.severity, 'error')
  assert.equal(diagnostic.phase, 'execute')
  assert.equal(diagnostic.stateEffect, 'partially-applied')
  assert.deepEqual(diagnostic.help, ['inspect existing bindings and retry only the failing expression'])
  assert.match(diagnostic.message, /^uncaught TypeError: value\.trim is not a function/)
  assert.equal(observed.raw.error.message, observed.raw.logs[0])
  assert.match(observed.raw.error.message, /^error\[PTC-X001\]: uncaught TypeError:/)
  assert.match(observed.raw.error.message, /state: partially-applied/)
  assert.deepEqual(await state.run('runtime-diagnostic', 'return value'), { logs: [], value: 1 })
})

test('normalizes hostile thrown values without terminating the runtime', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const multilineName = await state.runDurable('hostile-thrown-name', `
const namedError = new Error('named failure')
  namedError.name = 'Bad\\rName'
throw namedError
`)
  assert.equal(multilineName.meta.dshPtcPlus.diagnostics[0].message, 'uncaught Bad: named failure')

  const throwingCause = await state.runDurable('hostile-thrown-cause', `
const hostileThrown = { name: 'CustomError', message: 'semantic failure' }
Object.defineProperty(hostileThrown, 'ptcCause', { get() { throw new Error('cause getter escaped') } })
throw hostileThrown
`)
  assert.equal(throwingCause.meta.dshPtcPlus.diagnostics[0].message, 'uncaught CustomError: semantic failure')
  assert.equal(Object.hasOwn(throwingCause.meta.dshPtcPlus.diagnostics[0], 'cause'), false)
  assert.deepEqual(await state.run('hostile-thrown-cause', 'return 42'), { logs: [], value: 42 })
})

test('replays a durable runtime exception from its persisted diagnostic', async (t) => {
  const events = []
  const session = { id: 'replay-diagnostic', events }
  const first = fixture()
  t.after(() => first.dispose())

  const setupCode = 'let replayedAfterThrow = 0'
  const setup = await first.runDurable(session.id, setupCode, {}, { session })
  appendRunCodeEvents(events, 'replay-setup', setupCode, setup)
  const throwCode = 'replayedAfterThrow = 1\nthrow new TypeError("replay failure")'
  const thrown = await first.runDurable(session.id, throwCode, {}, { session })
  assert.equal(thrown.meta.dshPtcPlus.status, 'durable')
  assert.equal(thrown.meta.dshPtcPlus.diagnostics[0].code, 'PTC-X001')
  appendRunCodeEvents(events, 'replay-throw', throwCode, thrown)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, 'return replayedAfterThrow', {}, { session }), {
    logs: [],
    value: 1,
  })
})

test('fails closed when replay throws a different semantic exception than the journal', async (t) => {
  const events = []
  const session = { id: 'replay-forged-diagnostic', events }
  const first = fixture()
  t.after(() => first.dispose())

  const code = 'throw new TypeError("actual failure")'
  const actual = await first.runDurable(session.id, code, {}, { session })
  const forged = structuredClone(actual)
  const journal = forged.meta.dshPtcPlus
  journal.diagnostics[0].message = 'uncaught TypeError: forged failure'
  journal.completion.error.message = journal.completion.error.message.replaceAll('actual failure', 'forged failure')
  appendRunCodeEvents(events, 'replay-forged-throw', code, forged)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  const result = await restored.run(session.id, 'return 1', {}, { session })
  assert.equal(result.error.kind, 'recovery')
  assert.match(result.error.message, /cell replay produced a different semantic failure/)
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

  const observed = await state.executeRun('volatile-node', `
const fsModule = await import("node:fs")
return typeof fsModule.readFileSync
`, {}, {})
  const imported = observed.result
  assert.equal(imported.value, 'function')
  assert.equal(imported.meta.dshPtcPlus.status, 'volatile')
  const text = [
    'warning[PTC-V001]: Cell completed successfully and the REPL remains available in this process; PTC Plus status: volatile (module node:fs). Existing and new live bindings can be reused, but this cell and later cells are not replayed after restart until the durable head is restored.',
    'phase: execute',
    'state: unknown',
    'help: continue using the existing live bindings',
    'help: use repl.state({ action: "list" }) to inspect the current mode',
    'help: restore the durable head only when you need to discard the volatile suffix',
  ].join('\n')
  assert.deepEqual(observed.raw.logs, [text])
  assert.deepEqual(imported.meta.dshPtcPlus.diagnostics, [{
    code: 'PTC-V001',
    severity: 'warning',
    phase: 'execute',
    message: 'Cell completed successfully and the REPL remains available in this process; PTC Plus status: volatile (module node:fs). Existing and new live bindings can be reused, but this cell and later cells are not replayed after restart until the durable head is restored.',
    stateEffect: 'unknown',
    help: [
      'continue using the existing live bindings',
      'use repl.state({ action: "list" }) to inspect the current mode',
      'restore the durable head only when you need to discard the volatile suffix',
    ],
  }])
  const continued = await state.executeRun('volatile-node', 'return typeof fsModule.readFileSync', {}, {})
  assert.deepEqual(continued.raw, {
    logs: [],
    value: 'function',
  })
  assert.deepEqual(continued.result.meta.dshPtcPlus.diagnostics, [])
})

test('prepends the first volatile notice and does not repeat it after metadata removal', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const first = await state.executeRun('volatile-notice-once', `
console.log('ordinary')
void Date.now()
`, {}, {
    finalizeResult(result) {
      const { meta: _removed, ...withoutMeta } = result
      return withoutMeta
    },
  })
  assert.match(first.raw.logs[0], /^warning\[PTC-V001\]:/)
  assert.equal(first.raw.logs[1], 'ordinary')
  assert.equal(first.result.meta, undefined)

  const next = await state.executeRun('volatile-notice-once', 'return 42', {}, {})
  assert.deepEqual(next.raw, { logs: [], value: 42 })
  assert.deepEqual(next.result.meta.dshPtcPlus.diagnostics, [])
})

test('uses the session header cwd without inheriting the host process cwd', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const cwd = 'G:\\workspace\\session-project'
  const session = { id: 'session-cwd', header: { cwd }, events: [] }

  const recordedRun = await state.executeRun(session.id, 'return process.cwd()', {}, { session })
  const recorded = recordedRun.result
  assert.equal(recorded.value, cwd)
  assert.deepEqual(recordedRun.raw.logs, [])
  assert.equal(recorded.meta.dshPtcPlus.status, 'durable')

  const unrecordedRun = await state.executeRun('missing-session-cwd', 'return process.cwd()', {}, {})
  const unrecorded = unrecordedRun.result
  assert.equal(typeof unrecorded.value, 'string')
  assert.equal(unrecorded.meta.dshPtcPlus.status, 'volatile')
  assert.equal(unrecorded.meta.dshPtcPlus.volatileReason, 'process.cwd')
  assert.match(unrecordedRun.raw.logs[0], /PTC Plus status: volatile \(process\.cwd\)/)
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
  assert.match(result.error.message, /^error\[PTC-C002\]: cell import of node:worker_threads is forbidden/)
  assert.match(result.error.message, /phase: preflight\nstate: unchanged/)
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
  const observed = await restored.executeRun('session-rejected', 'return typeof shouldNeverExist', {}, { session })
  const text = [
    'warning[PTC-R002]: Restored the durable head and skipped 1 volatile or unconfirmed cell(s) from history; their source remains in the session log.',
    'phase: recover',
    'state: rolled-back',
    'help: continue from the restored bindings',
    'help: do not reference values created only in the skipped suffix',
  ].join('\n')
  assert.deepEqual(observed.raw, { logs: [text], value: 'undefined' })
  assert.deepEqual(observed.result.meta.dshPtcPlus.diagnostics, [{
    code: 'PTC-R002',
    severity: 'warning',
    phase: 'recover',
    message: 'Restored the durable head and skipped 1 volatile or unconfirmed cell(s) from history; their source remains in the session log.',
    stateEffect: 'rolled-back',
    help: [
      'continue from the restored bindings',
      'do not reference values created only in the skipped suffix',
    ],
  }])
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

test('excludes the current in-flight run_code call from history recovery', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const callId = 'current-call'
  const session = {
    id: 'session-current-call',
    events: [{
      type: 'tool/call',
      seq: 63,
      time: 63,
      data: {
        turn: 0,
        step: 0,
        callId,
        name: 'run_code',
        arguments: JSON.stringify({ code: 'return 1', description: 'current cell' }),
      },
    }],
  }
  assert.deepEqual(await state.run(session.id, 'return 1', {}, { session, callId }), {
    logs: [],
    value: 1,
  })
})

test('recovers prior durable history while excluding the current call', async (t) => {
  const events = []
  const session = { id: 'session-prior-and-current', events }
  const first = fixture()
  t.after(() => first.dispose())
  const priorCode = 'const priorDurableValue = 41'
  const prior = await first.runDurable(session.id, priorCode, {}, { session })
  appendRunCodeEvents(events, 'prior-call', priorCode, prior)
  await first.dispose()

  const callId = 'current-after-prior'
  events.push({
    type: 'tool/call',
    seq: events.length,
    time: events.length,
    data: {
      turn: 1,
      step: 0,
      callId,
      name: 'run_code',
      arguments: JSON.stringify({ code: 'return priorDurableValue + 1', description: 'current cell' }),
    },
  })
  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, 'return priorDurableValue + 1', {}, { session, callId }), {
    logs: [],
    value: 42,
  })
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
  assert.match(thrown.error.message, /^error\[PTC-X001\]: uncaught Error: converted failure/)
  assert.equal(thrown.meta.dshPtcPlus.status, 'volatile')
  assert.equal(thrown.meta.dshPtcPlus.volatileReason, 'Math.random')
  assert.deepEqual(thrown.meta.dshPtcPlus.diagnostics.map(item => item.code), ['PTC-X001', 'PTC-V001'])
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
  const live = await first.run(session.id, 'return durableValue + strippedValue')
  assert.equal(live.value, 42)
  assert.match(live.logs[0], /journal was not preserved in the final tool result/)
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
        diagnostics: [],
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
  assert.throws(() => apply({
    ...base,
    codeRuntime: { language: 'typescript', run() {} },
  }, { maxNestedRunCodeDepth: 0 }), /maxNestedRunCodeDepth must be a positive safe integer/)
})
