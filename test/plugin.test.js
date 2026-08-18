import assert from 'node:assert/strict'
import { access, rm } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { normalizeJournal } from '../internal/session-journal.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { decodeValue, encodeValue, renderValueWire } from '../internal/value-wire.js'

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
    tools: {
      get: name => name === 'run_code' ? runCodeDefinition : undefined,
      schemas: () => [runCodeDefinition, ...(fixtureOptions.schemas ?? [])],
    },
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
    listeners,
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

test('can disable durable replay while preserving live volatile continuation', async (t) => {
  const events = []
  const session = { id: 'durable-replay-disabled', events }
  const writer = fixture()

  const setupCode = 'let historicalBinding = 41'
  const setup = await writer.runDurable(session.id, setupCode, {}, { session })
  appendRunCodeEvents(events, 'durable-replay-setup', setupCode, setup)
  appendRunCodeEvents(events, 'durable-replay-corrupt', 'let corruptHistory = 1', {
    meta: { dshPtcPlus: { version: 999 } },
  })
  await writer.dispose()

  const state = fixture({ durableReplay: false })
  t.after(() => state.dispose())
  const first = await state.executeRun(session.id, 'return typeof historicalBinding', {}, { session })
  assert.equal(first.raw.value, 'undefined')
  assert.equal(first.result.meta.dshPtcPlus.status, 'volatile')
  assert.equal(
    first.result.meta.dshPtcPlus.volatileReason,
    'durable replay disabled by configuration',
  )
  assert.deepEqual(first.raw.logs, [])
  assert.deepEqual(first.result.meta.dshPtcPlus.diagnostics, [])

  const defined = await state.runDurable(session.id, 'let liveOnlyBinding = 42', {}, { session })
  assert.equal(defined.meta.dshPtcPlus.status, 'volatile')
  const reused = await state.runDurable(session.id, 'return liveOnlyBinding', {}, { session })
  assert.equal(reused.value, 42)
  assert.equal(reused.meta.dshPtcPlus.status, 'volatile')
  assert.deepEqual(reused.meta.dshPtcPlus.diagnostics, [])

  const save = await state.runDurable(
    session.id,
    'return await repl.state({ action: "save", name: "unavailable" })',
    {},
    { session },
  )
  assert.equal(save.isError, true)
  assert.equal(save.meta.dshPtcPlus.status, 'volatile')
  assert.match(save.error.message, /cannot save a durable REPL state from a volatile segment/)
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
  assert.match(guidance, /batch related independent observations in one cell/)
  assert.match(guidance, /one-off intermediates in a block/)
  assert.match(guidance, /Repeated top-level `const`\/`let` variable declarations replace existing bindings/)
  assert.match(guidance, /non-blocking `\[PTC-N002\]` note after an adjacent redeclaration/)
  assert.match(guidance, /Direct non-journalable Node\/process access changes only cold recovery/)
  assert.match(guidance, /Follow `\[PTC-\.\.\.\]` `help:` lines and retry only the failing part/)
  assert.match(guidance, /code\.run\(\{ code, description \}\).*returns `\{ logs, result\? \}`/)
  assert.match(guidance, /historical source may be read through available session-event capabilities/i)
  const strict = fixture({ looseTopLevelRedeclarations: false })
  t.after(() => strict.dispose())
  assert.match(strict.sections[0].text({}), /Redeclaring an existing top-level name fails before execution/)
  const volatileOnly = fixture({ durableReplay: false })
  t.after(() => volatileOnly.dispose())
  assert.match(
    volatileOnly.sections[0].text({}),
    /Durable replay is disabled for this profile\. Bindings remain reusable only in the current process; a new kernel starts empty\./,
  )
  state.ctx.tools.get = () => undefined
  assert.equal(state.sections[0].text({}), '')
})

test('canonicalizes hallucinated native and program tool calls before dispatch', async (t) => {
  const state = fixture({}, {
    schemas: [
      { name: 'read', parameters: { type: 'object' } },
      { name: 'write', parameters: { type: 'object' } },
      { name: 'skill', parameters: { type: 'object' } },
    ],
  })
  t.after(() => state.dispose())
  const session = { id: 'canonical-session' }
  await state.assemble({
    sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition],
  }, { agent: { id: 'agent', session }, scope: { id: 'scope' } })
  const source = [{
    type: 'tool-call-delta', index: 0, id: 'phantom', name: 'host.invoke',
    argumentsDelta: JSON.stringify({ name: 'skill', args: { name: 'example-skill' } }),
  }]
  const stream = state.listeners.get('llm/stream')[0]
  const result = []
  for await (const chunk of stream({
    sessionId: session.id,
    tools: [{ name: 'run_code' }],
  }, async function* () { yield* source })) result.push(chunk)
  assert.equal(result[0].name, 'run_code')
  assert.equal(result[0].id, 'phantom')
  const args = JSON.parse(result[0].argumentsDelta)
  assert.match(args.code, /host\.invoke/)
})

test('can disable tool-call canonicalization without changing the stream', async (t) => {
  const state = fixture({ canonicalizeToolCalls: false })
  t.after(() => state.dispose())
  const stream = state.listeners.get('llm/stream')[0]
  const source = [{ type: 'tool-call-delta', index: 0, id: 'raw', name: 'read', argumentsDelta: '{}' }]
  const result = []
  for await (const chunk of stream({ sessionId: 'disabled', tools: [{ name: 'run_code' }] }, async function* () { yield* source })) result.push(chunk)
  assert.deepEqual(result, source)
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

test('assembles one strict PTC capability grammar with translated workspace faces', async (t) => {
  const state = fixture({}, {
    schemas: [
      {
        name: 'read',
        description: 'Native read.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file_path: { type: 'string' },
            offset: { type: 'integer' },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'echo',
        description: 'Echo.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      },
      {
        name: 'glob',
        description: 'Find files by path pattern.',
        parameters: {
          type: 'object',
          properties: { pattern: { type: 'string' }, path: { type: 'string' } },
          required: ['pattern'],
        },
      },
      { name: 'get_goal', parameters: { type: 'object', properties: {} } },
      {
        name: 'update_goal',
        parameters: {
          type: 'object',
          properties: { goal_id: { type: 'string', description: 'Exact id returned by get_goal.' } },
          required: ['goal_id'],
        },
      },
      { name: 'job_output', parameters: { type: 'object', properties: { job_id: { type: 'string' } } } },
    ],
  })
  t.after(() => state.dispose())
  const assembly = {
    sections: [
      { name: 'tools:code-only', text: 'Only run_code is direct.' },
      { name: 'tool:read', text: 'Use the read tool.' },
      { name: 'tool:echo', text: 'Use the echo tool.' },
      {
        name: 'tool:glob',
        text: 'Use the glob tool — not shell find — to discover files. A pattern with no "/" matches basenames at any depth, so "*" matches every file in the tree rather than its top level.',
      },
      {
        name: 'rules',
        text: 'Use the read tool when inspecting files. Call get_goal before update_goal. Collect with job_output. Use goal tools for long-running work.\nKeep this rule.',
      },
      { name: 'tools:sdk', text: 'declare const tools: unknown' },
    ],
    contexts: [],
    variables: {},
    tools: [state.runCodeDefinition],
  }
  const adapted = await state.assemble(assembly, { scope: { id: 'strict-agent' } })
  assert.deepEqual(adapted.tools.map(tool => tool.name), ['run_code'])
  assert.equal(adapted.sections.some(section => section.name === 'tool:read'), false)
  assert.equal(adapted.sections.some(section => section.name === 'tool:echo'), false)
  assert.match(adapted.sections.find(section => section.name === 'tool:glob').text, /Use `workspace\.findFiles`.*not shell find/)
  assert.doesNotMatch(adapted.sections.find(section => section.name === 'tool:glob').text, /glob tool/)
  assert.match(adapted.sections.find(section => section.name === 'tool:glob').text, /pattern with no "\/" matches only the selected root/)
  assert.equal(adapted.sections.some(section => section.name === 'rules'), true)
  const rules = adapted.sections.find(section => section.name === 'rules').text
  assert.doesNotMatch(rules, /read tool|Call get_goal|before update_goal|with job_output/i)
  assert.match(rules, /`host\.invoke` capability "read"/)
  assert.match(rules, /`host\.invoke` capability "get_goal"/)
  assert.match(rules, /`host\.invoke` capability "update_goal"/)
  assert.match(rules, /`host\.invoke` capability "job_output"/)
  assert.match(rules, /goal capabilities/)
  const sdk = adapted.sections.find(section => section.name === 'tools:sdk').text
  assert.match(sdk, /declare const workspace:/)
  assert.match(sdk, /declare const repl:/)
  assert.match(sdk, /action: "save" \| "delete"; name: string/)
  assert.match(sdk, /names: string\[\]; mode: "durable" \| "volatile"/)
  assert.match(sdk, /readLines\(args: \{ path: string; offset\?: number; limit\?: number \}\)/)
  assert.match(sdk, /findFiles\(args: \{ pattern: string; root\?: string \}\): Promise<WorkspaceFiles>/)
  assert.match(sdk, /narrow root-level name pattern/)
  assert.match(sdk, /never guess an offset/)
  assert.match(sdk, /return \{ text: page\.lines\.map\(line => line\.text\)\.join\("\\n"\), totalLines: page\.totalLines \}/)
  assert.match(sdk, /accepts a regular file path, not a directory/)
  assert.match(sdk, /read a small set of authoritative entry documents together in one cell/)
  assert.match(sdk, /declare const code:/)
  assert.match(sdk, /declare const host:/)
  assert.match(sdk, /interface HostCapabilityArgs/)
  assert.match(sdk, /"echo"/)
  assert.match(sdk, /"read"/)
  assert.match(sdk, /"glob"/)
  assert.match(sdk, /Exact id returned by `host\.invoke` capability "get_goal"/)
  assert.match(sdk, /file_path: string/)
  assert.match(sdk, /message: string/)
  assert.match(sdk, /type HostCapabilityName = keyof HostCapabilityArgs/)
  assert.doesNotMatch(sdk, /declare const tools:|tools\.read|Use the read tool|returned by get_goal/)
})

test('fails closed on incompatible native glob guidance', async (t) => {
  const state = fixture({}, { schemas: [{ name: 'glob' }] })
  t.after(() => state.dispose())
  const base = {
    contexts: [], variables: {}, tools: [state.runCodeDefinition],
    sections: [{ name: 'tools:sdk', text: 'native sdk' }],
  }
  await assert.rejects(state.assemble({
    ...base,
    sections: [{ name: 'tool:glob', text: null }, ...base.sections],
  }), /incompatible glob guidance; expected rendered text/)
  await assert.rejects(state.assemble({
    ...base,
    sections: [{ name: 'tool:glob', text: 'Use the Glob tool.' }, ...base.sections],
  }), /incompatible glob guidance; native API reference remains/)
})

test('advertises cordis only for the exact known creator binding profile', async (t) => {
  const cordisNames = [
    'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self',
    'cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine',
  ]
  const assembly = state => ({
    sections: [
      {
        name: 'tool:cordis',
        text: [
          'Use cordis_inspect_list and cordis_inspect_query before cordis_define.',
          'Call cordis_inspect_self(pluginId, packageId) for source.',
          'Submit idPrefix with code.host or code.client as plain JavaScript.',
          'awaiting-approval and starting are not completed activation states.',
        ].join('\n'),
      },
      { name: 'tools:sdk', text: 'declare const tools: unknown' },
    ],
    contexts: [],
    variables: {},
    tools: [state.runCodeDefinition],
  })

  const complete = fixture({}, { schemas: cordisNames.map(name => ({ name })) })
  t.after(() => complete.dispose())
  const projected = await complete.assemble(assembly(complete))
  const guidance = projected.sections.find(section => section.name === 'tool:cordis').text
  assert.match(guidance, /methods on the optional `cordis` namespace inside `run_code`/)
  assert.match(guidance, /cordis\.inspectList and cordis\.inspect before cordis\.define/)
  assert.match(guidance, /cordis\.inspectSelf\(\{ pluginId, packageId \}\)/)
  assert.match(guidance, /target\.prefix with source\.host or source\.client as plain JavaScript/)
  assert.match(guidance, /awaiting-approval and starting are not completed activation states/)
  assert.doesNotMatch(guidance, /\bcordis_[a-z0-9_]+\b|idPrefix|code\.(?:host|client)/)
  const sdk = projected.sections.find(section => section.name === 'tools:sdk').text
  assert.match(sdk, /declare const cordis:/)
  assert.match(sdk, /target: \{ kind: "new"; prefix: string \}/)
  assert.doesNotMatch(sdk, /cordis_define|cordis_run|cordis_inspect_query/)

  const partial = fixture({}, { schemas: cordisNames.slice(0, -1).map(name => ({ name })) })
  t.after(() => partial.dispose())
  const partialProjection = await partial.assemble(assembly(partial))
  const partialSdk = partialProjection.sections.find(section => section.name === 'tools:sdk').text
  assert.doesNotMatch(partialSdk, /declare const cordis:/)
  assert.match(partialSdk, /type HostCapabilityName = keyof HostCapabilityArgs/)
  assert.match(partialSdk, /"cordis_define"/)
  assert.match(partialSdk, /"cordis_inspect_query"/)
  assert.match(partialSdk, /"cordis_run"/)
  assert.equal(partialProjection.sections.some(section => section.name === 'tool:cordis'), false)

  const absent = fixture()
  t.after(() => absent.dispose())
  const absentProjection = await absent.assemble(assembly(absent))
  const absentSdk = absentProjection.sections.find(section => section.name === 'tools:sdk').text
  assert.doesNotMatch(absentSdk, /declare const cordis:|cordis_define|cordis_run|cordis_inspect_query/)
  assert.equal(absentProjection.sections.some(section => section.name === 'tool:cordis'), false)

  const future = fixture({}, { schemas: [...cordisNames, 'cordis_future'].map(name => ({ name })) })
  t.after(() => future.dispose())
  const futureProjection = await future.assemble(assembly(future))
  const futureSdk = futureProjection.sections.find(section => section.name === 'tools:sdk').text
  assert.doesNotMatch(futureSdk, /declare const cordis:/)
  assert.match(futureSdk, /type HostCapabilityName = keyof HostCapabilityArgs/)
  assert.match(futureSdk, /"cordis_future"/)
  assert.equal(futureProjection.sections.some(section => section.name === 'tool:cordis'), false)

  await assert.rejects(complete.assemble({
    ...assembly(complete),
    sections: [{ name: 'tools:sdk', text: 'declare const tools: unknown' }],
  }), /Cordis profile has no guidance section/)
  await assert.rejects(complete.assemble({
    ...assembly(complete),
    sections: [
      { name: 'tool:cordis', text: 'Use cordis_future.' },
      { name: 'tools:sdk', text: 'declare const tools: unknown' },
    ],
  }), /unknown native API reference/)
  await assert.rejects(complete.assemble({
    ...assembly(complete),
    sections: [
      { name: 'tool:cordis', text: { rendered: false } },
      { name: 'tools:sdk', text: 'declare const tools: unknown' },
    ],
  }), /expected rendered text/)
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
    bindingMode: 'loose',
    status: 'durable',
    calls: [],
    operations: [],
    confirms: [],
    completion: { kind: 'return', hasValue: false },
  }), /invalid dsh-ptc-plus journal diagnostics/)
})

test('preflights every cross-cell binding collision with one actionable diagnostic', async (t) => {
  const state = fixture({ looseTopLevelRedeclarations: false })
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

test('replaces repeated top-level variables in default loose mode and cold-replays them', async (t) => {
  const events = []
  const session = { id: 'loose-redeclarations', events }
  const first = fixture()
  t.after(() => first.dispose())

  const setupCode = `
const repeatedValue = 40
const { repeatedLabel } = { repeatedLabel: 'first' }
`
  const setup = await first.runDurable(session.id, setupCode, {}, { session })
  assert.equal(setup.isError, false)
  appendRunCodeEvents(events, 'loose-setup', setupCode, setup)

  const replaceCode = `
const repeatedValue = repeatedValue + 1, addedAfterReplace = repeatedValue
const { repeatedLabel } = { repeatedLabel: repeatedLabel + '-second' }
return { repeatedValue, addedAfterReplace, repeatedLabel }
`
  const replaced = await first.runDurable(session.id, replaceCode, {}, { session })
  assert.deepEqual(replaced.value, {
    repeatedValue: 41,
    addedAfterReplace: 41,
    repeatedLabel: 'first-second',
  })
  appendRunCodeEvents(events, 'loose-replace', replaceCode, replaced)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, `
return { repeatedValue, addedAfterReplace, repeatedLabel }
`, {}, { session }), {
    logs: [],
    value: {
      repeatedValue: 41,
      addedAfterReplace: 41,
      repeatedLabel: 'first-second',
    },
  })
})

test('keeps injected capability namespaces reserved in loose mode', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const observed = await state.run('reserved-capability-binding', 'const { host } = globalThis')
  assert.equal(observed.error?.kind, 'exception')
  assert.match(observed.error?.message, /error\[PTC-N001\]: top-level bindings already exist: host/)
  assert.deepEqual(await state.run('reserved-capability-binding', 'return typeof host.invoke'), {
    logs: [],
    value: 'function',
  })
})

test('notes adjacent loose redeclarations without blocking or guessing across executed cells', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  await state.run('loose-redeclaration-note', 'const recentValue = 1\nconst recentLabel = "one"')
  const source = 'const recentValue = 2\nconst recentLabel = "two"\nreturn { recentValue, recentLabel }'
  const adjacent = await state.executeRun('loose-redeclaration-note', source, {}, {})
  assert.deepEqual(adjacent.raw.value, { recentValue: 2, recentLabel: 'two' })
  assert.equal(adjacent.raw.logs.length, 1)
  assert.match(adjacent.raw.logs[0], /^note\[PTC-N002\]: recent top-level bindings are redeclared in this cell: recentValue, recentLabel\./)
  assert.match(adjacent.raw.logs[0], /help: reuse the existing binding directly/)
  assert.deepEqual(adjacent.result.meta.dshPtcPlus.diagnostics.map(item => item.code), ['PTC-N002'])

  await state.run('loose-redeclaration-note', 'const broken =')
  const afterNoop = await state.run('loose-redeclaration-note', 'const recentValue = 3\nreturn recentValue')
  assert.equal(afterNoop.value, 3)
  assert.match(afterNoop.logs[0], /^note\[PTC-N002\]/)

  await state.run('loose-redeclaration-note', 'return recentValue')
  const afterExecutedGap = await state.run('loose-redeclaration-note', 'const recentValue = 4\nreturn recentValue')
  assert.deepEqual(afterExecutedGap, { logs: [], value: 4 })

  await state.run('loose-note-with-volatility', 'const volatileRecentValue = 1')
  const volatile = await state.executeRun(
    'loose-note-with-volatility',
    'const volatileRecentValue = Date.now()\nreturn volatileRecentValue',
    {},
    {},
  )
  assert.deepEqual(volatile.result.meta.dshPtcPlus.diagnostics.map(item => item.code), ['PTC-N002', 'PTC-V001'])
  assert.match(volatile.raw.logs[0], /^note\[PTC-N002\]/)
  assert.match(volatile.raw.logs[1], /^warning\[PTC-V001\]/)
})

test('reconstructs adjacent redeclaration reminders from the durable path', async (t) => {
  const events = []
  const session = { id: 'loose-note-replay', events }
  const writer = fixture()
  const source = 'const recoveredRecentValue = 1'
  const written = await writer.runDurable(session.id, source, {}, { session })
  appendRunCodeEvents(events, 'loose-note-setup', source, written)
  await writer.dispose()

  const reader = fixture()
  t.after(() => reader.dispose())
  const result = await reader.run(session.id, 'const recoveredRecentValue = 2\nreturn recoveredRecentValue', {}, { session })
  assert.equal(result.value, 2)
  assert.match(result.logs[0], /^note\[PTC-N002\]/)
})

test('preserves declaration TDZ while loosening new top-level const bindings', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  assert.deepEqual(await state.run('loose-tdz', `
const first = (() => {
  try { return typeof second }
  catch (error) { return error.name }
})(), second = 1
return { first, second }
`), {
    logs: [],
    value: { first: 'ReferenceError', second: 1 },
  })
})

test('replays each journal node with its recorded binding mode', async (t) => {
  const looseEvents = []
  const looseSession = { id: 'recorded-loose-mode', events: looseEvents }
  const looseWriter = fixture()
  const looseFirstCode = 'const switchedBinding = 1'
  const looseFirst = await looseWriter.runDurable(looseSession.id, looseFirstCode, {}, { session: looseSession })
  appendRunCodeEvents(looseEvents, 'loose-mode-first', looseFirstCode, looseFirst)
  const looseSecondCode = 'const switchedBinding = switchedBinding + 1'
  const looseSecond = await looseWriter.runDurable(looseSession.id, looseSecondCode, {}, { session: looseSession })
  appendRunCodeEvents(looseEvents, 'loose-mode-second', looseSecondCode, looseSecond)
  assert.equal(looseSecond.meta.dshPtcPlus.bindingMode, 'loose')
  await looseWriter.dispose()

  const strictReader = fixture({ looseTopLevelRedeclarations: false })
  t.after(() => strictReader.dispose())
  assert.deepEqual(await strictReader.run(looseSession.id, 'return switchedBinding', {}, { session: looseSession }), {
    logs: [],
    value: 2,
  })

  const strictEvents = []
  const strictSession = { id: 'recorded-strict-mode', events: strictEvents }
  const strictWriter = fixture({ looseTopLevelRedeclarations: false })
  const strictCode = 'const strictHistoryBinding = 3'
  const strictResult = await strictWriter.runDurable(strictSession.id, strictCode, {}, { session: strictSession })
  appendRunCodeEvents(strictEvents, 'strict-mode-cell', strictCode, strictResult)
  assert.equal(strictResult.meta.dshPtcPlus.bindingMode, 'strict')
  await strictWriter.dispose()

  const looseReader = fixture()
  t.after(() => looseReader.dispose())
  assert.deepEqual(await looseReader.run(strictSession.id, 'return strictHistoryBinding', {}, { session: strictSession }), {
    logs: [],
    value: 3,
  })
})

test('rejects a loose destructuring declarator that mixes existing and new bindings', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.run('loose-mixed-pattern', 'const existingPatternValue = 1')

  const result = await state.run('loose-mixed-pattern', `
const { existingPatternValue, newPatternValue } = { existingPatternValue: 2, newPatternValue: 3 }
`)
  assert.equal(result.error.kind, 'exception')
  assert.match(result.error.message, /error\[PTC-N001\]: top-level bindings already exist: existingPatternValue/)
  assert.deepEqual(await state.run('loose-mixed-pattern', `
return { existingPatternValue, newPatternType: typeof newPatternValue }
`), {
    logs: [],
    value: { existingPatternValue: 1, newPatternType: 'undefined' },
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

test('rebinds program capabilities for old functions and expires captured closures', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  await state.run('session-a', `
async function currentValue() { return host.invoke({ name: 'value', args: {} }) }
const staleValue = host.invoke
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

test('projects read and compatibility bindings through one governed host call', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const calls = []
  const functions = {
    async read(args) {
      calls.push(['read', args])
      return { path: args.file_path, offset: args.offset ?? 1, lines: [{ number: 2, text: 'line' }], totalLines: 3 }
    },
    async echo(args) {
      calls.push(['echo', args])
      return args
    },
    async glob(args) {
      calls.push(['glob', args])
      return { root: args.path ?? '.', paths: ['README.md', 'docs/architecture.md'] }
    },
  }
  const observed = await state.executeRun('capability-projection', `
const page = await workspace.readLines({ path: 'src/a.ts', offset: 2, limit: 1 })
const found = await workspace.findFiles({ pattern: 'docs/**/*.md', root: '.' })
const allReadmes = await workspace.findFiles({ pattern: 'README.md' })
const rootFiles = await workspace.findFiles({ pattern: '*' })
const nativePage = await host.invoke({ name: 'read', args: { file_path: 'src/raw.ts', limit: 1 } })
const echoed = await host.invoke({ name: 'echo', args: { value: 7 } })
return { page, found, allReadmes, rootFiles, nativePage, echoed, rawTools: typeof tools }
`, functions, {})
  assert.deepEqual(observed.raw, {
    logs: [],
    value: {
      page: { path: 'src/a.ts', offset: 2, lines: [{ number: 2, text: 'line' }], totalLines: 3 },
      found: { root: '.', files: ['README.md', 'docs/architecture.md'] },
      allReadmes: { root: '.', files: ['README.md', 'docs/architecture.md'] },
      rootFiles: { root: '.', files: ['README.md', 'docs/architecture.md'] },
      nativePage: { path: 'src/raw.ts', offset: 1, lines: [{ number: 2, text: 'line' }], totalLines: 3 },
      echoed: { value: 7 },
      rawTools: 'undefined',
    },
  })
  assert.deepEqual(calls, [
    ['read', { file_path: 'src/a.ts', offset: 2, limit: 1 }],
    ['glob', { pattern: 'docs/**/*.md', path: '.' }],
    ['glob', { pattern: '/README.md' }],
    ['glob', { pattern: '/*' }],
    ['read', { file_path: 'src/raw.ts', limit: 1 }],
    ['echo', { value: 7 }],
  ])
  assert.deepEqual(observed.result.meta.dshPtcPlus.calls.map(call => [call.global, call.member]), [
    ['workspace', 'readLines'],
    ['workspace', 'findFiles'],
    ['workspace', 'findFiles'],
    ['workspace', 'findFiles'],
    ['host', 'invoke'],
    ['host', 'invoke'],
  ])
})

test('rebuilds and validates the workspace.readLines program result contract', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const extended = await state.executeRun('read-result-contract', `
try {
  await workspace.readLines({ path: 'src/a.ts' })
} catch (error) {
  return { name: error.name, operation: error.operation, message: error.message }
}
`, {
    read: async args => ({
      path: args.file_path,
      offset: 1,
      lines: [{ number: 1, text: 'line' }],
      totalLines: 1,
      nativePresentationHint: 'ts',
    }),
  }, {})
  assert.deepEqual(extended.raw.value, {
    name: 'WorkspaceError',
    operation: 'readLines',
    message: 'workspace.readLines host result received unknown or non-enumerable fields',
  })

  const malformed = await state.executeRun('read-result-contract', `
try {
  await workspace.readLines({ path: 'src/a.ts' })
} catch (error) {
  return { name: error.name, operation: error.operation, message: error.message }
}
`, {
    read: async args => ({ path: args.file_path, offset: 1, lines: [{ number: 1 }], totalLines: 1 }),
  }, {})
  assert.deepEqual(malformed.raw.value, {
    name: 'WorkspaceError',
    operation: 'readLines',
    message: 'workspace.readLines host result lines[0] text must be an enumerable data property',
  })
})

test('projects the exact known Cordis profile through translated program contracts', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const calls = []
  const functions = {
    async cordis_inspect_list(args) {
      calls.push(['cordis_inspect_list', args])
      return { providers: [{ id: 'Service', platform: 'host' }] }
    },
    async cordis_inspect_query(args) {
      calls.push(['cordis_inspect_query', args])
      return { ...args, data: { methods: ['listService'] } }
    },
    async cordis_inspect_self(args) {
      calls.push(['cordis_inspect_self', args])
      return { mode: 'plugins', plugins: [] }
    },
    async cordis_define(args) {
      calls.push(['cordis_define', args])
      return {
        pluginId: 'demo-1', packageId: 'pkg-1', name: args.name, purpose: args.purpose,
        hasHostHalf: true, hasClientHalf: false,
      }
    },
    async cordis_run(args) {
      calls.push(['cordis_run', args])
      return { status: 'awaiting-approval', ...args, pluginRunId: 'run-1', nextPackageId: args.packageId }
    },
    async cordis_stop(args) {
      calls.push(['cordis_stop', args])
      return { pluginId: args.pluginId }
    },
    async cordis_undefine(args) {
      calls.push(['cordis_undefine', args])
      return { pluginId: args.pluginId, wasRunning: false }
    },
  }
  const observed = await state.executeRun('cordis-projection', `
const providers = await cordis.inspectList()
const inspected = await cordis.inspect({ platform: 'host', provider: 'Service', method: 'listService' })
const owned = await cordis.inspectSelf()
const defined = await cordis.define({
  target: { kind: 'new', prefix: 'demo' },
  name: 'Demo',
  purpose: 'Provide one temporary capability.',
  source: { host: 'return ctx => {}' },
})
const activated = await cordis.run({ pluginId: defined.pluginId, packageId: defined.packageId, mode: 'run' })
const stopped = await cordis.stop({ pluginId: defined.pluginId })
const removed = await cordis.undefine({ pluginId: defined.pluginId })
return { providers, inspected, owned, defined, activated, stopped, removed, rawTools: typeof tools }
`, functions, {})

  assert.deepEqual(observed.raw.value.providers, [{ id: 'Service', platform: 'host' }])
  assert.deepEqual(observed.raw.value.inspected, { methods: ['listService'] })
  assert.deepEqual(observed.raw.value.owned, { mode: 'plugins', plugins: [] })
  assert.equal(observed.raw.value.activated.status, 'awaiting-approval')
  assert.equal(observed.raw.value.rawTools, 'undefined')
  assert.deepEqual(calls, [
    ['cordis_inspect_list', {}],
    ['cordis_inspect_query', { platform: 'host', provider: 'Service', method: 'listService' }],
    ['cordis_inspect_self', {}],
    ['cordis_define', {
      plugin: { kind: 'new', idPrefix: 'demo' },
      name: 'Demo',
      purpose: 'Provide one temporary capability.',
      code: { host: 'return ctx => {}' },
    }],
    ['cordis_run', { pluginId: 'demo-1', packageId: 'pkg-1', mode: 'run' }],
    ['cordis_stop', { pluginId: 'demo-1' }],
    ['cordis_undefine', { pluginId: 'demo-1' }],
  ])
  assert.equal(observed.result.meta.dshPtcPlus.status, 'volatile')
  assert.equal(observed.result.meta.dshPtcPlus.volatileReason, 'cordis.run')
  assert.deepEqual(observed.result.meta.dshPtcPlus.calls.map(call => [call.global, call.member]), [
    ['cordis', 'inspectList'], ['cordis', 'inspect'], ['cordis', 'inspectSelf'], ['cordis', 'define'],
    ['cordis', 'run'], ['cordis', 'stop'], ['cordis', 'undefine'],
  ])
})

test('keeps unmatched Cordis bindings reachable only through host.invoke', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const observed = await state.executeRun('partial-cordis', `
const providers = await host.invoke({ name: 'cordis_inspect_list', args: {} })
return { cordisType: typeof cordis, providers }
`, { cordis_inspect_list: async () => ({ providers: [] }) }, {})
  assert.deepEqual(observed.raw.value, {
    cordisType: 'undefined',
    providers: { providers: [] },
  })
  assert.equal(observed.result.meta.dshPtcPlus.status, 'volatile')
  assert.equal(observed.result.meta.dshPtcPlus.volatileReason, 'host.invoke(cordis_inspect_list)')

  const unavailable = async () => null
  const future = await state.run('future-cordis', `
const known = await host.invoke({ name: 'cordis_inspect_list', args: {} })
const future = await host.invoke({ name: 'cordis_future', args: {} })
return { cordisType: typeof cordis, known, future }
`, {
    cordis_inspect_list: async () => ({ providers: [] }),
    cordis_inspect_query: unavailable,
    cordis_inspect_self: unavailable,
    cordis_define: unavailable,
    cordis_run: unavailable,
    cordis_stop: unavailable,
    cordis_undefine: unavailable,
    cordis_future: async () => ({ future: true }),
  })
  assert.deepEqual(future.value, {
    cordisType: 'undefined',
    known: { providers: [] },
    future: { future: true },
  })

  const mutation = await state.executeRun('raw-cordis-mutation', `
try {
  await host.invoke({ name: 'cordis_define', args: { source: 'opaque' } })
} catch {}
return 42
`, {
    cordis_define: async () => { throw new Error('mutation may already have happened') },
  }, {})
  assert.equal(mutation.raw.value, 42)
  assert.equal(mutation.result.meta.dshPtcPlus.status, 'volatile')
  assert.equal(mutation.result.meta.dshPtcPlus.volatileReason, 'host.invoke(cordis_define)')
})

test('keeps typed Cordis definition durable and degrades uncertain mutations', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const unavailable = async () => { throw new Error('creator mutation rejected') }
  const functions = {
    cordis_inspect_list: async () => ({ providers: [] }),
    cordis_inspect_query: async args => ({ ...args, data: null }),
    cordis_inspect_self: async () => ({ mode: 'plugins', plugins: [] }),
    cordis_define: unavailable,
    cordis_run: unavailable,
    cordis_stop: unavailable,
    cordis_undefine: unavailable,
  }
  const observed = await state.executeRun('rejected-cordis', `
try {
  await cordis.define({
    target: { kind: 'new', prefix: 'demo' },
    name: 'Demo',
    purpose: 'Rejected definition.',
    source: { host: 'return ctx => {}' },
  })
} catch (error) {
  return { name: error.name, operation: error.operation, message: error.message }
}
`, functions, {})
  assert.deepEqual(observed.raw.value, {
    name: 'CordisError', operation: 'define', message: 'creator mutation rejected',
  })
  assert.equal(observed.result.meta.dshPtcPlus.status, 'durable')
  assert.equal(observed.result.meta.dshPtcPlus.volatileReason, undefined)
  assert.deepEqual(observed.raw.logs, [])

  const malformed = await state.executeRun('malformed-cordis-result', `
try {
  await cordis.define({
    target: { kind: 'new', prefix: 'demo' },
    name: 'Demo',
    purpose: 'Malformed definition result.',
    source: { host: 'return ctx => {}' },
  })
} catch (error) {
  return { name: error.name, operation: error.operation }
}
`, {
    ...functions,
    cordis_define: async () => ({
      pluginId: 'demo-1', packageId: 'pkg-1', name: 'Demo', purpose: 'Malformed definition result.',
      hasHostHalf: true, hasClientHalf: false, nativeExtra: true,
    }),
  }, {})
  assert.deepEqual(malformed.raw.value, { name: 'CordisError', operation: 'define' })
  assert.equal(malformed.result.meta.dshPtcPlus.status, 'volatile')
  assert.equal(malformed.result.meta.dshPtcPlus.volatileReason, 'cordis.define')
})

test('cold-replays typed Cordis definitions through a remapped runner identity', async (t) => {
  const events = []
  const session = { id: 'cordis-durable-replay', events }
  let nextId = 1
  let registry = new Map()
  let coldDefineGate
  const functions = () => ({
    cordis_inspect_list: async () => ({ providers: [] }),
    cordis_inspect_query: async args => ({ ...args, data: null }),
    cordis_inspect_self: async args => ({
      exists: registry.has(args.pluginId), pluginId: args.pluginId, packageId: args.packageId,
    }),
    cordis_define: async args => {
      if (coldDefineGate !== undefined) await coldDefineGate
      const pluginId = `demo-${nextId++}`
      const packageId = `pkg-${nextId++}`
      registry.set(pluginId, packageId)
      return {
        pluginId, packageId, name: args.name, purpose: args.purpose,
        hasHostHalf: true, hasClientHalf: false,
      }
    },
    cordis_run: async () => ({ ok: false, reason: 'unused', message: 'unused' }),
    cordis_stop: async () => ({ ok: true }),
    cordis_undefine: async args => ({ pluginId: args.pluginId, wasRunning: false }),
  })
  const first = fixture()
  t.after(() => first.dispose())
  const code = `const defined = await cordis.define({
  target: { kind: 'new', prefix: 'demo' },
  name: 'Durable Demo',
  purpose: 'Rebuild a Cordis registry entry.',
  source: { host: 'return ctx => {}' },
})

return defined.pluginId`
  const recorded = await first.runDurable(session.id, code, functions(), { session })
  assert.equal(recorded.meta.dshPtcPlus.status, 'durable')
  assert.equal(recorded.meta.dshPtcPlus.cordisEffects, undefined)
  assert.deepEqual(recorded.value, 'demo-1')
  appendRunCodeEvents(events, 'cordis-durable-define', code, recorded)
  await first.dispose()

  nextId = 99
  registry = new Map()
  let releaseColdDefine
  coldDefineGate = new Promise(resolve => { releaseColdDefine = resolve })
  const cold = fixture()
  t.after(() => cold.dispose())
  let settled = false
  const inspection = cold.runDurable(session.id,
    'return await cordis.inspectSelf({ pluginId: defined.pluginId, packageId: "pkg-2" })',
    functions(), { session }).then((value) => { settled = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  releaseColdDefine()
  const inspected = await inspection
  assert.deepEqual(inspected.value, { exists: true, pluginId: 'demo-1', packageId: 'pkg-2' })
})

test('validates recorded Cordis failures during cold replay', async (t) => {
  const events = []
  const session = { id: 'cordis-failure-replay', events }
  const code = `try {
  await cordis.define({
    target: { kind: 'new', prefix: 'demo' },
    name: 'Denied',
    purpose: 'Record one semantic failure.',
    source: { host: 'return ctx => {}' },
  })
} catch (error) {
  return error.message
}`
  const base = {
    cordis_inspect_list: async () => ({ providers: [] }),
    cordis_inspect_query: async args => ({ ...args, data: null }),
    cordis_inspect_self: async () => ({ mode: 'plugins', plugins: [] }),
    cordis_run: async () => ({ ok: false, reason: 'unused', message: 'unused' }),
    cordis_stop: async args => ({ pluginId: args.pluginId }),
    cordis_undefine: async args => ({ pluginId: args.pluginId, wasRunning: false }),
  }
  const first = fixture()
  const denied = { ...base, cordis_define: async () => { throw new Error('definition denied') } }
  const recorded = await first.runDurable(session.id, code, denied, { session })
  assert.equal(recorded.meta.dshPtcPlus.status, 'durable')
  appendRunCodeEvents(events, 'cordis-failure-source', code, recorded)
  await first.dispose()

  const matching = fixture()
  t.after(() => matching.dispose())
  const restored = await matching.runDurable(session.id, 'return 1', denied, { session })
  assert.equal(restored.value, 1)
  await matching.dispose()

  const differentFailure = fixture()
  t.after(() => differentFailure.dispose())
  const changed = await differentFailure.runDurable(session.id, 'return 1', {
    ...base,
    cordis_define: async () => { throw new Error('different denial') },
  }, { session })
  assert.equal(changed.isError, true)
  assert.match(changed.error.message, /Cordis replay failure diverged/)
  await differentFailure.dispose()

  const divergent = fixture()
  t.after(() => divergent.dispose())
  const mismatch = await divergent.runDurable(session.id, 'return 1', {
    ...base,
    cordis_define: async args => ({
      pluginId: 'demo-2', packageId: 'pkg-2', name: args.name, purpose: args.purpose,
      hasHostHalf: true, hasClientHalf: false,
    }),
  }, { session })
  assert.equal(mismatch.isError, true)
  assert.match(mismatch.error.message, /Cordis replay succeeded where "definition denied" was recorded/)
})

test('retracts rebuilt Cordis plugins when domain replay diverges', async (t) => {
  const events = []
  const session = { id: 'cordis-replay-rollback', events }
  const code = `await cordis.define({
  target: { kind: 'new', prefix: 'demo' },
  name: 'Expected',
  purpose: 'Verify replay rollback.',
  source: { host: 'return ctx => {}' },
})`
  const first = fixture()
  const base = {
    cordis_inspect_list: async () => ({ providers: [] }),
    cordis_inspect_query: async args => ({ ...args, data: null }),
    cordis_inspect_self: async () => ({ mode: 'plugins', plugins: [] }),
    cordis_run: async () => ({ ok: false, reason: 'unused', message: 'unused' }),
    cordis_stop: async args => ({ pluginId: args.pluginId }),
  }
  const recorded = await first.runDurable(session.id, code, {
    ...base,
    cordis_define: async args => ({
      pluginId: 'demo-1', packageId: 'pkg-1', name: args.name, purpose: args.purpose,
      hasHostHalf: true, hasClientHalf: false,
    }),
    cordis_undefine: async args => ({ pluginId: args.pluginId, wasRunning: false }),
  }, { session })
  appendRunCodeEvents(events, 'cordis-replay-rollback-source', code, recorded)
  await first.dispose()

  const registry = new Set()
  const cold = fixture()
  t.after(() => cold.dispose())
  const result = await cold.runDurable(session.id, 'return 1', {
    ...base,
    cordis_define: async args => {
      registry.add('runtime-demo')
      return {
        pluginId: 'runtime-demo', packageId: 'runtime-package', name: 'Different', purpose: args.purpose,
        hasHostHalf: true, hasClientHalf: false,
      }
    },
    cordis_undefine: async args => {
      registry.delete(args.pluginId)
      return { pluginId: args.pluginId, wasRunning: false }
    },
  }, { session })
  assert.equal(result.isError, true)
  assert.match(result.error.message, /Cordis replay result diverged/)
  assert.equal(registry.size, 0)
})

test('cold-replays a completed Host-only Cordis Fiber activation', async (t) => {
  const events = []
  const session = { id: 'cordis-host-run-replay', events }
  let generation = 1
  let waitingFor = ['Service']
  let extraRunField = false
  const observedCalls = []
  const functions = () => ({
    cordis_inspect_list: async () => ({ providers: [] }),
    cordis_inspect_query: async args => ({ ...args, data: null }),
    cordis_inspect_self: async () => ({ mode: 'plugins', plugins: [] }),
    cordis_define: async args => {
      const result = {
        pluginId: `host-${generation}`, packageId: `pkg-${generation}`,
        name: args.name, purpose: args.purpose, hasHostHalf: true, hasClientHalf: false,
      }
      observedCalls.push(['define', result.pluginId, result.packageId])
      return result
    },
    cordis_run: async args => {
      observedCalls.push(['run', args.pluginId, args.packageId])
      return {
        ok: true, status: 'running', ...args, pluginRunId: `run-${generation}`,
        waitingFor: [...waitingFor], currentPackageId: args.packageId,
        ...(extraRunField ? { unexpected: true } : {}),
      }
    },
    cordis_stop: async args => ({ pluginId: args.pluginId }),
    cordis_undefine: async args => {
      observedCalls.push(['undefine', args.pluginId])
      return { pluginId: args.pluginId, wasRunning: true }
    },
  })
  const code = `const hostDefined = await cordis.define({
  target: { kind: 'new', prefix: 'host' },
  name: 'Host only',
  purpose: 'Restore one completed Fiber.',
  source: { host: 'return ctx => {}' },
})

const hostRun = await cordis.run({ pluginId: hostDefined.pluginId, packageId: hostDefined.packageId, mode: 'run' })
await cordis.undefine({ pluginId: hostDefined.pluginId })
return hostRun.pluginRunId`
  const first = fixture()
  const recorded = await first.runDurable(session.id, code, functions(), { session })
  assert.equal(recorded.meta.dshPtcPlus.status, 'durable')
  appendRunCodeEvents(events, 'cordis-host-run-source', code, recorded)
  await first.dispose()

  generation = 9
  observedCalls.length = 0
  const cold = fixture()
  t.after(() => cold.dispose())
  const restored = await cold.runDurable(session.id,
    'return [hostDefined.pluginId, hostDefined.packageId, hostRun.pluginRunId, hostRun.waitingFor]',
    functions(), { session })
  assert.deepEqual(restored.value, ['host-1', 'pkg-1', 'run-1', ['Service']])
  assert.deepEqual(observedCalls, [
    ['define', 'host-9', 'pkg-9'],
    ['run', 'host-9', 'pkg-9'],
    ['undefine', 'host-9'],
  ])
  await cold.dispose()

  generation = 10
  waitingFor = []
  observedCalls.length = 0
  const arrayMismatch = fixture()
  t.after(() => arrayMismatch.dispose())
  const arrayResult = await arrayMismatch.runDurable(session.id, 'return 1', functions(), { session })
  assert.equal(arrayResult.isError, true)
  assert.match(arrayResult.error.message, /Cordis replay result diverged at \$\.waitingFor/)
  await arrayMismatch.dispose()

  generation = 11
  waitingFor = ['Service']
  extraRunField = true
  const shapeMismatch = fixture()
  t.after(() => shapeMismatch.dispose())
  const shapeResult = await shapeMismatch.runDurable(session.id, 'return 1', functions(), { session })
  assert.equal(shapeResult.isError, true)
  assert.match(shapeResult.error.message, /Cordis replay result diverged at \$/)
})

test('fails closed when Cordis logical identity changes during replay', async (t) => {
  const events = []
  const session = { id: 'cordis-identity-divergence', events }
  const code = `const identityBase = await cordis.define({
  target: { kind: 'new', prefix: 'iden' }, name: 'Base', purpose: 'Create identity.',
  source: { host: 'return ctx => {}' },
})
await cordis.define({
  target: { kind: 'existing', pluginId: identityBase.pluginId }, name: 'Next', purpose: 'Reuse identity.',
  source: { host: 'return ctx => {}' },
})`
  const common = {
    cordis_inspect_list: async () => ({ providers: [] }),
    cordis_inspect_query: async args => ({ ...args, data: null }),
    cordis_inspect_self: async () => ({ mode: 'plugins', plugins: [] }),
    cordis_run: async () => ({ ok: false, reason: 'unused', message: 'unused' }),
    cordis_stop: async args => ({ pluginId: args.pluginId }),
    cordis_undefine: async args => ({ pluginId: args.pluginId, wasRunning: false }),
  }
  let firstDefine = true
  const first = fixture()
  const recorded = await first.runDurable(session.id, code, {
    ...common,
    cordis_define: async args => {
      const result = {
        pluginId: 'iden-1', packageId: firstDefine ? 'pkg-1' : 'pkg-2',
        name: args.name, purpose: args.purpose, hasHostHalf: true, hasClientHalf: false,
      }
      firstDefine = false
      return result
    },
  }, { session })
  appendRunCodeEvents(events, 'cordis-identity-source', code, recorded)
  await first.dispose()

  let coldDefine = 0
  const cold = fixture()
  t.after(() => cold.dispose())
  const result = await cold.runDurable(session.id, 'return 1', {
    ...common,
    cordis_define: async args => {
      coldDefine += 1
      return {
        pluginId: coldDefine === 1 ? 'runtime-a' : 'runtime-b', packageId: `runtime-pkg-${coldDefine}`,
        name: args.name, purpose: args.purpose, hasHostHalf: true, hasClientHalf: false,
      }
    },
  }, { session })
  assert.equal(result.isError, true)
  assert.match(result.error.message, /Cordis replay identity diverged/)
})

test('preserves a cancelled Cordis mutation boundary without attributing its late settlement', async (t) => {
  const state = fixture({ computeMs: 1_000, maxWallMs: 2_000 })
  t.after(() => state.dispose())
  let signalDefineStarted
  const defineStarted = new Promise(resolve => { signalDefineStarted = resolve })
  let settleDefine
  const delayedDefine = new Promise(resolve => { settleDefine = resolve })
  const controller = new AbortController()
  const functions = {
    cordis_inspect_list: async () => ({ providers: [] }),
    cordis_inspect_query: async args => ({ ...args, data: null }),
    cordis_inspect_self: async () => ({ mode: 'plugins', plugins: [] }),
    cordis_define: async () => { signalDefineStarted(); return delayedDefine },
    cordis_run: async () => { throw new Error('unused') },
    cordis_stop: async () => { throw new Error('unused') },
    cordis_undefine: async () => { throw new Error('unused') },
  }
  const cancelled = state.executeRun('late-cordis', `
await cordis.define({
  target: { kind: 'new', prefix: 'demo' },
  name: 'Demo',
  purpose: 'Complete after cancellation.',
  source: { host: 'return ctx => {}' },
})
`, functions, { controller })
  await defineStarted
  controller.abort('cancel delayed Cordis mutation')
  const cancelledResult = await cancelled
  assert.equal(cancelledResult.result.meta.dshPtcPlus.status, 'discarded')
  assert.equal(cancelledResult.result.meta.dshPtcPlus.volatileReason, 'cordis.define')

  let signalHoldStarted
  const holdStarted = new Promise(resolve => { signalHoldStarted = resolve })
  let settleHold
  const next = state.executeRun('late-cordis', 'return await host.invoke({ name: "hold", args: {} })', {
    hold: async () => { signalHoldStarted(); return new Promise(resolve => { settleHold = resolve }) },
  }, {})
  await holdStarted
  settleDefine({
    pluginId: 'demo-1', packageId: 'pkg-1', name: 'Demo', purpose: 'Complete after cancellation.',
    hasHostHalf: true, hasClientHalf: false,
  })
  await Promise.resolve()
  settleHold(42)
  const nextResult = await next
  assert.equal(nextResult.raw.value, 42)
  assert.equal(nextResult.result.meta.dshPtcPlus.status, 'volatile')
  assert.equal(nextResult.result.meta.dshPtcPlus.volatileReason, 'cordis.define')
  assert.match(nextResult.raw.logs[0], /^warning\[PTC-V001\]/)
})

test('injects code.run and routes it to the isolated upstream runtime', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const childCode = 'const childOnly = 1; return childOnly'
  const functions = { read: async () => 'visible' }

  const observed = await state.executeRun('recursive-isolation', `
const parentOnly = 41
const nestedOutcome = await code.run({
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
  const childWorkspace = state.upstreamCalls[0].bindings.find(binding => binding.global === 'workspace')
  assert.equal(typeof childWorkspace.functions.readLines, 'function')
  const childCodeBinding = state.upstreamCalls[0].bindings.find(binding => binding.global === 'code')
  assert.equal(typeof childCodeBinding.functions.run, 'function')
  assert.equal(Object.hasOwn(functions, 'run_code'), false)
  assert.equal(observed.result.meta.dshPtcPlus.status, 'durable')
  assert.deepEqual(observed.result.meta.dshPtcPlus.calls.map(call => [call.global, call.member]), [
    ['code', 'run'],
  ])
  assert.deepEqual(await state.run('recursive-isolation', `
return { parentOnly, childOnly: typeof childOnly }
`), { logs: [], value: { parentOnly: 41, childOnly: 'undefined' } })
})

test('attributes nested Cordis creator mutations to the owning parent cell', async (t) => {
  const functions = {
    cordis_inspect_list: async () => ({ providers: [] }),
    cordis_inspect_query: async args => ({ ...args, data: null }),
    cordis_inspect_self: async () => ({ mode: 'plugins', plugins: [] }),
    cordis_define: async args => ({
      pluginId: 'nested-1', packageId: 'package-1', name: args.name, purpose: args.purpose,
      hasHostHalf: true, hasClientHalf: false,
    }),
    cordis_run: async () => { throw new Error('unused') },
    cordis_stop: async () => { throw new Error('unused') },
    cordis_undefine: async () => { throw new Error('unused') },
  }
  const state = fixture({}, {
    async upstreamRun(request) {
      const cordis = request.bindings.find(binding => binding.global === 'cordis').functions
      const defined = await cordis.define({
        target: { kind: 'new', prefix: 'nest' },
        name: 'Nested',
        purpose: 'Define from an isolated child.',
        source: { host: 'return ctx => {}' },
      })
      return { logs: [], value: defined.pluginId }
    },
  })
  t.after(() => state.dispose())

  const observed = await state.executeRun('nested-cordis-mutation', `
return code.run({ code: 'define nested plugin', description: 'Define nested Cordis plugin' })
`, functions, {})
  assert.equal(observed.raw.value.result, 'nested-1')
  assert.equal(observed.result.meta.dshPtcPlus.status, 'durable')
  assert.equal(observed.result.meta.dshPtcPlus.volatileReason, undefined)
  assert.deepEqual(observed.result.meta.dshPtcPlus.calls.map(call => [call.global, call.member]), [
    ['code', 'run'],
  ])
  assert.deepEqual(observed.result.meta.dshPtcPlus.cordisEffects.map(effect => effect.member), ['define'])
})

test('cold-replays nested Cordis effects without re-running the child program', async (t) => {
  const events = []
  const session = { id: 'nested-cordis-replay', events }
  let nextId = 1
  let registry = new Map()
  const functions = () => ({
    cordis_inspect_list: async () => ({ providers: [] }),
    cordis_inspect_query: async args => ({ ...args, data: null }),
    cordis_inspect_self: async args => ({ exists: registry.has(args.pluginId), pluginId: args.pluginId, packageId: args.packageId }),
    cordis_define: async args => {
      const pluginId = `nested-${nextId++}`
      const packageId = `package-${nextId++}`
      registry.set(pluginId, packageId)
      return { pluginId, packageId, name: args.name, purpose: args.purpose, hasHostHalf: true, hasClientHalf: false }
    },
    cordis_run: async () => ({ ok: false, reason: 'unused', message: 'unused' }),
    cordis_stop: async () => ({ ok: true }),
    cordis_undefine: async args => ({ pluginId: args.pluginId, wasRunning: false }),
  })
  const childCode = `const defined = await cordis.define({
  target: { kind: 'new', prefix: 'nest' },
  name: 'Nested',
  purpose: 'Rebuild a nested effect.',
  source: { host: 'return ctx => {}' },
})
return defined.pluginId`
  const first = fixture({}, {
    async upstreamRun(request) {
      const cordis = request.bindings.find(binding => binding.global === 'cordis').functions
      const defined = await cordis.define({
        target: { kind: 'new', prefix: 'nest' },
        name: 'Nested',
        purpose: 'Rebuild a nested effect.',
        source: { host: 'return ctx => {}' },
      })
      return { logs: [], value: defined.pluginId }
    },
  })
  t.after(() => first.dispose())
  const code = `return code.run({ code: ${JSON.stringify(childCode)}, description: 'Define nested plugin' })`
  const recorded = await first.runDurable(session.id, code, functions(), { session })
  assert.equal(recorded.meta.dshPtcPlus.status, 'durable')
  assert.deepEqual(recorded.value, { logs: [], result: 'nested-1' })
  appendRunCodeEvents(events, 'nested-cordis-replay-source', code, recorded)
  await first.dispose()

  nextId = 99
  registry = new Map()
  const cold = fixture({}, {
    async upstreamRun() {
      throw new Error('nested child must be reconstructed from Cordis transcript')
    },
  })
  t.after(() => cold.dispose())
  const inspected = await cold.runDurable(session.id,
    'return await cordis.inspectSelf({ pluginId: "nested-1", packageId: "package-2" })',
    functions(), { session })
  assert.deepEqual(inspected.value, { exists: true, pluginId: 'nested-1', packageId: 'package-2' })
  await cold.dispose()

  const missingProfile = fixture()
  t.after(() => missingProfile.dispose())
  const unavailable = await missingProfile.runDurable(session.id, 'return 1', {}, { session })
  assert.equal(unavailable.isError, true)
  assert.match(unavailable.error.message, /Cordis replay requires the typed capability profile/)
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
return code.run({ code: 'return 1', description: 'Use host recursion' })
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
      const runCode = request.bindings.find(binding => binding.global === 'code').functions.run
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
return code.run({ code: '1', description: 'Evaluate two child levels' })
`), {
    logs: [],
    value: { logs: [], result: { logs: ['leaf'], result: 0 } },
  })

  const overflow = await state.run('recursive-depth-overflow', `
return code.run({ code: '2', description: 'Exceed child depth limit' })
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
  await code.run({ code: 'return 1', description: 'Reject extra input', extra: true })
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
  await code.run({ code: 'for (;;) {}', description: 'Reach child timeout' })
} catch (error) {
  childFailure = { name: error.name, operation: error.operation, message: error.message }
}
return childFailure
`, {}, { controller })
  assert.deepEqual(result, {
    logs: [],
    value: {
      name: 'CodeExecutionError',
      operation: 'run',
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
  const code = `const recursiveReplayResult = await code.run({
  code: 'return 42',
  description: 'Compute isolated child value',
})`
  const recorded = await first.runDurable(session.id, code, {}, { session })
  assert.equal(first.upstreamCalls.length, 1)
  assert.equal(recorded.meta.dshPtcPlus.calls[0].member, 'run')
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
try { await host.invoke({ name: 'fail', args: {} }) } catch (error) {
  caught = { name: error.name, operation: error.operation, message: error.message }
}
return caught
`, { fail: async () => { throw new Error('denied') } })
  assert.deepEqual(result, {
    logs: [],
    value: { name: 'HostCapabilityError', operation: 'invoke', message: 'denied' },
  })
})

test('preserves available host error codes as a structured diagnostic cause', async (t) => {
  const events = []
  const session = { id: 'host-cause', events }
  const state = fixture()
  t.after(() => state.dispose())

  const code = 'return await workspace.readLines({ path: "missing" })'
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

  const observed = await state.executeRun('host-hostile-error', 'return await host.invoke({ name: "fail", args: {} })', {
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

  const invalid = await state.executeRun('session-a', 'return { temp: undefined }', {}, {})
  assert.equal(invalid.raw.error, undefined)
  assert.equal(invalid.raw.value, '{temp: undefined}')
  assert.equal(invalid.result.meta.dshPtcPlus.status, 'durable')
  assert.deepEqual(invalid.result.meta.dshPtcPlus.diagnostics, [])
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

test('round-trips the canonical PTC value graph without losing JavaScript graph semantics', () => {
  const shared = { value: 1 }
  const sparse = new Array(3)
  sparse[1] = undefined
  const input = Object.create(null)
  Object.defineProperty(input, '__proto__', {
    value: shared, enumerable: true, writable: true, configurable: true,
  })
  Object.defineProperties(input, {
    alias: { value: shared, enumerable: true, writable: true, configurable: true },
    sparse: { value: sparse, enumerable: true, writable: true, configurable: true },
    values: {
      value: [NaN, Infinity, -Infinity, -0, 12345678901234567890n],
      enumerable: true, writable: true, configurable: true,
    },
    self: { value: input, enumerable: true, writable: true, configurable: true },
  })

  const wire = encodeValue(input)
  assert.equal(JSON.parse(JSON.stringify(wire)).codec, 'ptc-value-graph/v1')
  const output = decodeValue(wire)
  assert.equal(Object.getPrototypeOf(output), null)
  assert.equal(Object.hasOwn(output, '__proto__'), true)
  assert.equal(output.__proto__, output.alias)
  assert.equal(output.self, output)
  assert.equal(0 in output.sparse, false)
  assert.equal(1 in output.sparse, true)
  assert.equal(output.sparse[1], undefined)
  assert.equal(2 in output.sparse, false)
  assert.equal(Number.isNaN(output.values[0]), true)
  assert.equal(output.values[1], Infinity)
  assert.equal(output.values[2], -Infinity)
  assert.equal(Object.is(output.values[3], -0), true)
  assert.equal(output.values[4], 12345678901234567890n)
  assert.deepEqual(encodeValue(output), wire)
})

test('rejects executable, accessor, malformed, and over-budget PTC values', () => {
  let getterCalls = 0
  const accessor = {}
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() { getterCalls += 1; return 1 },
  })
  assert.throws(() => encodeValue(accessor), /property must be an enumerable data property/)
  assert.equal(getterCalls, 0)

  for (const value of [() => 1, new Date(0), Promise.resolve(1), new Map()]) {
    assert.throws(() => encodeValue(value), /not PTC Value V1/)
  }
  assert.throws(() => decodeValue({
    codec: 'ptc-value-graph/v1',
    root: { tag: 'reference', index: 1 },
    nodes: [],
  }), /dangling PTC value reference/)
  assert.throws(() => decodeValue({
    codec: 'ptc-value-graph/v1',
    root: { tag: 'mystery' },
    nodes: [],
  }), /unknown PTC value atom tag/)
  assert.throws(() => decodeValue({
    codec: 'ptc-value-graph/v1', extra: true,
    root: null,
    nodes: [],
  }), /invalid PTC value envelope field extra/)
  assert.throws(() => encodeValue([1, 2], { maxEdges: 1 }), /edge budget exceeds 1/)
})

test('encodes and decodes deeply nested PTC values without recursive stack growth', () => {
  let input = null
  for (let depth = 0; depth < 5_000; depth += 1) input = [input]
  const wire = encodeValue(input)
  let output = decodeValue(wire)
  for (let depth = 0; depth < 5_000; depth += 1) output = output[0]
  assert.equal(output, null)
})

test('renders array holes distinctly from explicit undefined values', () => {
  assert.equal(renderValueWire(encodeValue(new Array(1))), '[,]')
  assert.equal(renderValueWire(encodeValue(new Array(2))), '[, ,]')
  assert.equal(renderValueWire(encodeValue([, undefined, null])), '[, undefined, null]')
  assert.equal(renderValueWire(encodeValue([undefined])), '[undefined]')
})

test('projects supported rich values and rejects values outside PTC Value V1', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const shared = await state.run('session-a', `
const sharedItem = { value: 1 }
return [sharedItem, sharedItem]
`)
  assert.deepEqual(shared, { logs: [], value: '[<ref *1> {value: 1}, [Reference *1]]' })

  for (const source of [
    'return new Date(0)',
    'const value = {}; value[Symbol("x")] = 1; return value',
    'const value = []; value.extra = 1; return value',
  ]) {
    const result = await state.run(`invalid-${source.length}`, source)
    assert.ok(['invalid-output', 'exception'].includes(result.error.kind))
  }
  assert.deepEqual(await state.run('special-number', 'return -0'), { logs: [], value: '-0' })
})

test('distinguishes an explicit undefined completion from no completion value', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const explicit = await state.executeRun('explicit-undefined', 'return undefined', {}, {})
  assert.deepEqual(explicit.raw, { logs: [], value: 'undefined' })
  assert.equal(explicit.result.meta.dshPtcPlus.completion.hasValue, true)
  assert.deepEqual(decodeValue(explicit.result.meta.dshPtcPlus.completion.value), undefined)

  const absent = await state.executeRun('absent-value', 'const noCompletionValue = 1', {}, {})
  assert.deepEqual(absent.raw, { logs: [] })
  assert.equal(absent.result.meta.dshPtcPlus.completion.hasValue, false)
  assert.equal(Object.hasOwn(absent.result.meta.dshPtcPlus.completion, 'value'), false)
})

test('persists and cold-replays a rich completion through session-log JSON alone', async (t) => {
  const events = []
  const session = { id: 'rich-value-replay', events }
  const first = fixture()
  t.after(() => first.dispose())
  const code = `
const richReplayShared = { value: undefined }
const richReplaySparse = [, undefined, null]
const richReplayState = {
  shared: richReplayShared,
  alias: richReplayShared,
  sparse: richReplaySparse,
  negativeZero: -0,
  big: 42n,
}
richReplayState.self = richReplayState
return richReplayState
`
  const recorded = await first.runDurable(session.id, code, {}, { session })
  assert.equal(recorded.meta.dshPtcPlus.status, 'durable')
  assert.equal(recorded.meta.dshPtcPlus.completion.hasValue, true)
  assert.equal(recorded.meta.dshPtcPlus.completion.value.codec, 'ptc-value-graph/v1')
  appendRunCodeEvents(events, 'rich-value-cell', code, JSON.parse(JSON.stringify(recorded)))
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, `return {
    alias: richReplayState.shared === richReplayState.alias,
    cycle: richReplayState.self === richReplayState,
    hole: !(0 in richReplayState.sparse),
    explicitUndefined: 1 in richReplayState.sparse && richReplayState.sparse[1] === undefined,
    negativeZero: Object.is(richReplayState.negativeZero, -0),
    bigint: richReplayState.big === 42n,
  }`, {}, { session }), {
    logs: [],
    value: {
      alias: true,
      cycle: true,
      hole: true,
      explicitUndefined: true,
      negativeZero: true,
      bigint: true,
    },
  })
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

test('provides an isolated absolute scratch directory without inheriting host environment', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const result = await state.run('session-scratch', `
const osForScratch = await import('node:os')
return {
  directory: osForScratch.tmpdir(),
  temp: process.env.TEMP,
  tmp: process.env.TMP,
  tmpdir: process.env.TMPDIR,
  hasSystemRoot: process.env.SystemRoot !== undefined,
}
`)
  assert.equal(isAbsolute(result.value.directory), true)
  assert.equal(result.value.directory.includes('undefined'), false)
  assert.equal(result.value.temp, result.value.directory)
  assert.equal(result.value.tmp, result.value.directory)
  assert.equal(result.value.tmpdir, result.value.directory)
  assert.equal(result.value.hasSystemRoot, false)
  await access(result.value.directory)

  const other = await state.run('session-scratch-other', `
const otherScratchOs = await import('node:os')
return otherScratchOs.tmpdir()
`)
  assert.equal(isAbsolute(other.value), true)
  assert.notEqual(other.value, result.value.directory)
  await access(other.value)

  await state.dispose()
  await assert.rejects(access(result.value.directory))
  await assert.rejects(access(other.value))
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
return await host.invoke({ name: 'measureDepth', args: { value: nestedArgument } })
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
  assert.match(returned.error.message, /^error\[PTC-O001\]: cell result could not cross the PTC Value V1 boundary:/)
  assert.equal(returned.meta.dshPtcPlus.status, 'durable')

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
  const pending = state.runDurable('pending-call-abort', 'await host.invoke({ name: "neverSettles", args: {} })', {
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
  const firstCode = 'const persistedValue = await host.invoke({ name: "readValue", args: {} })'
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
  const secondCode = 'return persistedValue + await host.invoke({ name: "answer", args: {} })'
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
  host.invoke({ name: 'slow', args: {} }),
  host.invoke({ name: 'fast', args: {} }),
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
        bindingMode: 'loose',
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
  assert.throws(() => apply({
    ...base,
    codeRuntime: { language: 'typescript', run() {} },
  }, { maxValueNodes: 0 }), /maxValueNodes must be a positive safe integer/)
  assert.throws(() => apply({
    ...base,
    codeRuntime: { language: 'typescript', run() {} },
  }, { looseTopLevelRedeclarations: 'yes' }), /looseTopLevelRedeclarations must be a boolean/)
  assert.throws(() => apply({
    ...base,
    codeRuntime: { language: 'typescript', run() {} },
  }, { durableReplay: 'yes' }), /durableReplay must be a boolean/)
  assert.throws(() => apply({
    ...base,
    codeRuntime: { language: 'typescript', run() {} },
  }, { canonicalizeToolCalls: 'yes' }), /canonicalizeToolCalls must be a boolean/)
})

test('rejects malformed projected adapter requests and workspace results', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const programs = [
    'return code.run(null)',
    'return workspace.readLines({ path: "" })',
    'return workspace.readLines({ path: "a", offset: 0 })',
    'return workspace.readLines({ path: "a", limit: 1.5 })',
    'return workspace.findFiles(null)',
    'return workspace.findFiles({ pattern: "" })',
    'return workspace.findFiles({ pattern: "*", root: "" })',
    'return workspace.findFiles({ pattern: "*", extra: true })',
    'return host.invoke({ name: "", args: {} })',
    'return host.invoke({ name: "missing", args: {} })',
  ]
  for (const [index, program] of programs.entries()) {
    const observed = await state.run(`adapter-invalid-${index}`, program, {
      read: async () => ({ path: 'a', offset: 1, lines: [], totalLines: 0 }),
      glob: async () => ({ root: '.', paths: [] }),
    })
    assert.equal(observed.error.kind, 'exception')
  }

  const outcomes = [
    { path: '', offset: 1, lines: [], totalLines: 0 },
    { path: 'a', offset: 0, lines: [], totalLines: 0 },
    { path: 'a', offset: 1, lines: [], totalLines: -1 },
    { path: 'a', offset: 1, lines: null, totalLines: 0 },
    { path: 'a', offset: 1, lines: [{ number: 0, text: '' }], totalLines: 1 },
    { path: 'a', offset: 1, lines: [{ number: 1, text: 2 }], totalLines: 1 },
  ]
  for (const [index, outcome] of outcomes.entries()) {
    const observed = await state.run(`read-result-invalid-${index}`, 'return workspace.readLines({ path: "a" })', {
      read: async () => outcome,
    })
    assert.equal(observed.error.kind, 'exception')
  }

  const globOutcomes = [
    { root: '', paths: [] },
    { root: '.', paths: null },
    { root: '.', paths: [''] },
    { root: '.', paths: [], extra: true },
  ]
  for (const [index, outcome] of globOutcomes.entries()) {
    const observed = await state.run(
      `glob-result-invalid-${index}`,
      'return workspace.findFiles({ pattern: "README.md" })',
      { glob: async () => outcome },
    )
    assert.equal(observed.error.kind, 'exception')
  }
})

test('preflights complex scopes and rewrites returns through catch patterns', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const scoped = await state.run('complex-scopes', `
const [first, , third = 3, ...tail] = [1, 2, undefined, 4]
const { value: renamed, nested: { item }, ...rest } = { value: 5, nested: { item: 6 }, extra: 7 }
function outer({ input = 1 }, ...args) {
  var local = input
  function nested() { return Date.now() }
  return local + args.length
}
class LocalClass {}
{
  const Date = { now: () => 8 }
  function blockFunction() { return Date.now() }
  class BlockClass {}
  blockFunction()
}
for (const loopValue of [1]) { void loopValue }
for (let loopIndex = 0; loopIndex < 1; loopIndex += 1) { void loopIndex }
try { throw { reason: 1 } } catch ({ reason }) { void reason }
try { throw 1 } catch { void 0 }
return { first, third, tail, renamed, item, rest, outer: outer({}), className: LocalClass.name }
`)
  assert.deepEqual(scoped.value, {
    first: 1, third: 3, tail: [4], renamed: 5, item: 6, rest: { extra: 7 }, outer: 1, className: 'LocalClass',
  })

  const values = [
    ['try { return 11 } catch ({ message }) { return message }', 11],
    ['try { return 12 } catch { return 0 }', 12],
    ['try { throw { value: 13 } } catch ({ value }) { return value }', 13],
    ['try { throw 14 } catch { return 14 }', 14],
    ['return', 'undefined'],
  ]
  for (const [index, [program, expected]] of values.entries()) {
    assert.equal((await state.run(`return-rewrite-${index}`, program)).value, expected)
  }
})

test('validates state requests and classifies computed ambient access', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const invalid = [
    'return repl.state(null)',
    'return repl.state([])',
    'return repl.state({ action: "unknown" })',
    'return repl.state({ action: "save" })',
    'return repl.state({ action: "delete", name: "" })',
    'return repl.state({ action: "restore", name: "missing" })',
  ]
  for (const [index, program] of invalid.entries()) {
    assert.equal((await state.run(`state-invalid-${index}`, program)).error.kind, 'exception')
  }

  const volatile = [
    'const moduleName = "node:url"; await import(moduleName); return 1',
    'return globalThis["Date"].now()',
    'return Math["random"]()',
    'return process["platform"]',
  ]
  for (const [index, program] of volatile.entries()) {
    const result = await state.runDurable(`volatile-classification-${index}`, program)
    assert.equal(result.meta.dshPtcPlus.status, 'volatile')
  }
})

test('rejects every malformed Cordis program request and host result', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const validFunctions = () => ({
    cordis_inspect_list: async () => ({ providers: [] }),
    cordis_inspect_query: async args => ({ ...args, data: null }),
    cordis_inspect_self: async () => ({ mode: 'plugins', plugins: [] }),
    cordis_define: async args => ({
      pluginId: 'plugin', packageId: 'package', name: args.name, purpose: args.purpose,
      hasHostHalf: true, hasClientHalf: false,
    }),
    cordis_run: async args => ({ ...args, status: 'running' }),
    cordis_stop: async args => ({ pluginId: args.pluginId }),
    cordis_undefine: async args => ({ pluginId: args.pluginId, wasRunning: false }),
  })
  const invalidPrograms = [
    'return cordis.inspectList({})',
    'return cordis.inspect({ platform: "bad", provider: "p", method: "m" })',
    'return cordis.inspect({ platform: "host", provider: "", method: "m", input: null })',
    'return cordis.inspectSelf({ packageId: "package" })',
    'return cordis.inspectSelf({ pluginId: "" })',
    'return cordis.define({ target: { kind: "new", prefix: "p", pluginId: "x" }, name: "n", purpose: "p", source: { host: "x" } })',
    'return cordis.define({ target: { kind: "existing", pluginId: "p", prefix: "x" }, name: "n", purpose: "p", source: { host: "x" } })',
    'return cordis.define({ target: { kind: "bad" }, name: "n", purpose: "p", source: { host: "x" } })',
    'return cordis.define({ target: { kind: "new", prefix: "p" }, name: "n", purpose: "p", source: {} })',
    'return cordis.define({ target: { kind: "new", prefix: "p" }, name: "n", purpose: "p", source: { host: 1 } })',
    'return cordis.run({ pluginId: "p", packageId: "x", mode: "bad" })',
    'return cordis.stop({ pluginId: "" })',
  ]
  for (const [index, program] of invalidPrograms.entries()) {
    const result = await state.run(`cordis-request-invalid-${index}`, program, validFunctions())
    assert.equal(result.error.kind, 'exception')
  }

  const invalidOutcomes = [
    ['cordis.inspectList()', 'cordis_inspect_list', { providers: null }],
    ['cordis.inspect({ platform: "host", provider: "p", method: "m", input: 1 })', 'cordis_inspect_query', { platform: 'client', provider: 'p', method: 'm', data: null }],
    ['cordis.inspectSelf()', 'cordis_inspect_self', { mode: 'plugins', plugins: [], missing: undefined }],
    ['cordis.inspectSelf()', 'cordis_inspect_self', { mode: 'plugins', invalid: () => {} }],
    ['cordis.define({ target: { kind: "new", prefix: "p" }, name: "n", purpose: "p", source: { client: "x" } })', 'cordis_define', { pluginId: 'p', packageId: 'x', name: 'n', purpose: 'p', hasHostHalf: 'yes', hasClientHalf: false }],
    ['cordis.run({ pluginId: "p", packageId: "x", mode: "run" })', 'cordis_run', { status: 'running', missing: undefined }],
    ['cordis.stop({ pluginId: "p" })', 'cordis_stop', { pluginId: '' }],
    ['cordis.undefine({ pluginId: "p" })', 'cordis_undefine', { pluginId: 'p', wasRunning: 'no' }],
  ]
  for (const [index, [expression, binding, outcome]] of invalidOutcomes.entries()) {
    const functions = validFunctions()
    functions[binding] = async () => outcome
    const result = await state.run(`cordis-result-invalid-${index}`, `return ${expression}`, functions)
    assert.equal(result.error.kind, 'exception')
  }

  const existing = await state.run('cordis-existing-target', `
return cordis.define({
  target: { kind: 'existing', pluginId: 'plugin' }, name: 'n', purpose: 'p',
  source: { host: 'h', client: 'c' },
})
`, validFunctions())
  assert.equal(existing.error, undefined)
})

test('covers plugin hook early exits and metadata installation failures', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const execute = state.listeners.get('tools/execute')[0]
  const result = state.listeners.get('tools/result')[0]
  assert.equal(await execute({ name: 'other' }, async () => 'next'), 'next')
  assert.equal(await execute({ name: 'run_code', parent: {}, agent: { id: 'a' } }, async () => 'nested'), 'nested')
  assert.equal(await execute({ name: 'run_code', agent: {} }, async () => 'anonymous'), 'anonymous')
  result({ name: 'other' }, {})
  result({ name: 'run_code', parent: {}, agent: { id: 'a' } }, {})
  result({ name: 'run_code', agent: {} }, {})
  await state.emit('session/disposed', { id: 'absent' })

  const missing = fixture()
  t.after(() => missing.dispose())
  missing.ctx.tools.get = () => undefined
  await assert.rejects(() => missing.executeRun('missing-definition', 'return 1', {}, {}), /definition is unavailable/)

  const noOutput = fixture()
  t.after(() => noOutput.dispose())
  noOutput.runCodeDefinition.output = undefined
  await assert.rejects(() => noOutput.executeRun('missing-output', 'return 1', {}, {}), /has no output projection/)

  const frozen = fixture()
  t.after(() => frozen.dispose())
  Object.freeze(frozen.runCodeDefinition.output)
  await assert.rejects(() => frozen.executeRun('frozen-output', 'return 1', {}, {}), /cannot attach the session journal/)

  const original = fixture()
  original.runCodeDefinition.output.presentationMeta = () => ({ original: true })
  await original.runDurable('original-metadata', 'return 1')
  await original.dispose()
  assert.deepEqual(original.runCodeDefinition.output.presentationMeta(), { original: true })

  await assert.rejects(() => state.assemble({ tools: null }), /expected a tools array/)
})

test('rejects malformed direct runtime requests and hostile host errors', async (t) => {
  const runtime = new SessionRuntime({ computeMs: 100, maxWallMs: 1_000 })
  t.after(() => runtime.dispose())
  const invalid = [
    [{ program: 1, bindings: [] }, /program must be a string/],
    [{ program: 'return 1', bindings: null }, /bindings must be an array/],
    [{ program: 'return 1', bindings: [null] }, /invalid binding namespace/],
    [{ program: 'return 1', bindings: [{ global: 'bad', functions: null }] }, /invalid bad functions/],
    [{ program: 'return 1', bindings: [{ global: 'bad', functions: { call: 1 } }] }, /binding bad\.call is not a function/],
  ]
  for (const [index, [request, expected]] of invalid.entries()) {
    const result = await runtime.run(`direct-invalid-${index}`, request)
    assert.equal(result.error.kind, 'exception')
    assert.match(result.error.message, expected)
  }

  const controller = new AbortController()
  controller.abort('already stopped')
  assert.deepEqual(await runtime.run('direct-aborted', {
    program: 'return 1', bindings: [], signal: controller.signal,
  }), { logs: [], error: { kind: 'abort', message: 'already stopped' } })

  const hostile = Object.create(null)
  Object.defineProperty(hostile, 'message', { get() { throw new Error('hidden') } })
  hostile[Symbol.toPrimitive] = () => { throw new Error('unprintable') }
  const thrown = await runtime.run('hostile-host-error', {
    program: 'return api.fail({})',
    bindings: [{ global: 'api', functions: { fail: async () => { throw hostile } } }],
  })
  assert.equal(thrown.error.kind, 'exception')
  assert.match(thrown.error.message, /Unprintable error/)

  for (const [index, thrownValue] of [7, '', Object.assign(function failure() {}, { message: 'function error' })].entries()) {
    const result = await runtime.run(`host-error-shape-${index}`, {
      program: 'return api.fail({})',
      bindings: [{ global: 'api', functions: { fail: async () => { throw thrownValue } } }],
    })
    assert.equal(result.error.kind, 'exception')
  }
})

test('handles direct runtime recovery, timeout, volatility, and lifecycle boundaries', async (t) => {
  const timed = new SessionRuntime({ computeMs: 1_000, maxWallMs: 20 })
  t.after(() => timed.dispose())
  const timeout = await timed.run('wall-timeout', { program: 'await new Promise(() => {})', bindings: [] })
  assert.equal(timeout.error.kind, 'timeout')
  assert.match(timeout.error.message, /wall-clock ceiling/)

  assert.equal(timed.markVolatile(null, 'reason'), false)
  assert.equal(timed.markVolatile({}, ''), false)
  assert.equal(timed.markVolatile({ id: 'absent' }, 'reason'), false)
  timed.finalize(undefined, true)
  timed.finalize({}, false)
  await timed.disposeSession('absent')

  const invalidHistory = new SessionRuntime()
  t.after(() => invalidHistory.dispose())
  const duplicate = {
    type: 'tool/result', sourceEventSeqs: [1], data: { meta: { dshPtcPlus: {
      version: 1, bindingMode: 'loose', status: 'noop', calls: [], operations: [], confirms: [], diagnostics: [],
    } } },
  }
  const recovered = await invalidHistory.run({ id: 'invalid-history', session: { events: [duplicate, duplicate] } }, {
    program: 'return 1', bindings: [],
  })
  assert.equal(recovered.error.kind, 'recovery')

  const disposed = new SessionRuntime()
  await disposed.dispose()
  assert.deepEqual(await disposed.run('disposed', { program: 'return 1', bindings: [] }), {
    logs: [], error: { kind: 'abort', message: 'PTC runtime disposed' },
  })

  const duringRun = new SessionRuntime({ computeMs: 1_000, maxWallMs: 1_000 })
  const pending = duringRun.run('dispose-active', { program: 'await new Promise(() => {})', bindings: [] })
  await duringRun.dispose()
  assert.equal((await pending).error.kind, 'abort')
})

test('rejects every semantic replay mismatch', async (t) => {
  const cases = [
    {
      name: 'recorded-success-actual-throw',
      code: 'throw new Error("actual")',
      completion: { kind: 'return', hasValue: false },
    },
    {
      name: 'recorded-throw-actual-success',
      code: 'void 0',
      completion: { kind: 'throw', error: { kind: 'exception', message: 'recorded' } },
    },
    {
      name: 'recorded-durable-actual-volatile',
      code: 'void Date.now()',
      completion: { kind: 'return', hasValue: false },
    },
    {
      name: 'recorded-value-mismatch',
      code: 'return 2',
      completion: { kind: 'return', hasValue: true, value: encodeValue(1) },
    },
    {
      name: 'recorded-extra-call',
      code: 'void 0',
      calls: [{
        global: 'api', member: 'call', args: encodeValue({}), ok: true,
        value: encodeValue(null), settle: 0,
      }],
      completion: { kind: 'return', hasValue: false },
    },
  ]
  for (const item of cases) {
    const session = { id: item.name, events: [] }
    appendRunCodeEvents(session.events, item.name, item.code, { meta: { dshPtcPlus: {
      version: 1,
      bindingMode: 'loose',
      status: 'durable',
      calls: item.calls ?? [],
      operations: [],
      confirms: [],
      diagnostics: [],
      completion: item.completion,
    } } })
    const state = fixture()
    t.after(() => state.dispose())
    const result = await state.run(item.name, 'return 1', { call: async () => null }, { session })
    assert.equal(result.error.kind, 'recovery')
  }

  const session = { id: 'recorded-call-mismatch', events: [] }
  const code = 'return await host.invoke({ name: "call", args: { value: 1 } })'
  appendRunCodeEvents(session.events, 'recorded-call-mismatch', code, { meta: { dshPtcPlus: {
    version: 1,
    bindingMode: 'loose',
    status: 'durable',
    calls: [{
      global: 'host', member: 'invoke', args: encodeValue({ name: 'call', args: { value: 2 } }),
      ok: true, value: encodeValue(null), settle: 0,
    }],
    operations: [], confirms: [], diagnostics: [],
    completion: { kind: 'return', hasValue: true, value: encodeValue(null) },
  } } })
  const state = fixture()
  t.after(() => state.dispose())
  assert.equal((await state.run(session.id, 'return 1', { call: async () => null }, { session })).error.kind, 'recovery')
})

test('covers runtime worker setup and state-operation failures', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.runDurable('class-redeclare', 'class ExistingClass {}\nfunction existingFunction() {}')
  assert.equal((await state.run('class-redeclare', 'class ExistingClass {}')).error.kind, 'exception')
  assert.equal((await state.run('class-redeclare', 'function existingFunction() {}')).error.kind, 'exception')
  assert.equal((await state.run('array-parameter', 'function take([first, ...rest] = []) { return [first, rest] }\nreturn take([1, 2])')).error, undefined)

  const volatileSave = await state.run('volatile-save-error', `
void Date.now()
return repl.state({ action: 'save', name: 'not-durable' })
`)
  assert.equal(volatileSave.error.kind, 'exception')

  await state.runDurable('delete-state', `
void await repl.state({ action: 'save', name: 'temporary' })
`)
  const deleted = await state.runDurable('delete-state', `
return repl.state({ action: 'delete', name: 'temporary' })
`)
  assert.deepEqual(deleted.value, { action: 'delete', name: 'temporary', deleted: true })

  const cloneFailure = new SessionRuntime()
  t.after(() => cloneFailure.dispose())
  const cloneResult = await cloneFailure.run('clone-failure', {
    program: 'return api.call({})',
    bindings: [{
      global: 'api',
      functions: { call: async () => null },
      errorClass: { name: 'ApiError', invalid: () => {} },
    }],
  })
  assert.equal(cloneResult.error.kind, 'worker-exit')

  const tempKeys = ['TMPDIR', 'TEMP', 'TMP']
  const priorTemp = Object.fromEntries(tempKeys.map(key => [key, process.env[key]]))
  for (const key of tempKeys) process.env[key] = 'relative-temp'
  try {
    const invalidTemp = new SessionRuntime()
    t.after(() => invalidTemp.dispose())
    const result = await invalidTemp.run('invalid-temp', { program: 'return 1', bindings: [] })
    assert.equal(result.error.kind, 'worker-exit')
    assert.match(result.error.message, /temporary directory must be absolute/)
  } finally {
    for (const key of tempKeys) {
      if (priorTemp[key] === undefined) delete process.env[key]
      else process.env[key] = priorTemp[key]
    }
  }

  const exiting = new SessionRuntime({ computeMs: 1_000, maxWallMs: 1_000 })
  t.after(() => exiting.dispose())
  const exited = await exiting.run('worker-exit', { program: 'process.reallyExit(7)', bindings: [] })
  assert.equal(exited.error.kind, 'worker-exit')

  const direct = new SessionRuntime()
  t.after(() => direct.dispose())
  const context = { id: 'inactive-control', callId: 'one' }
  await direct.run(context, { program: 'return 1', bindings: [] })
  assert.throws(() => context.kernel.controlState({ action: 'list' }), /unavailable outside a cell/)

  assert.deepEqual(context.kernel.withControlBinding([], undefined, undefined), [])
  context.kernel.completeJournal(undefined, 'noop', { logs: [] })
  context.kernel.onMessage({}, null)
  context.kernel.onMessage(context.kernel.worker, { type: 'ignored' })
  context.kernel.failWorker({}, 'stale worker')
  const savedWorker = context.kernel.worker
  context.kernel.worker = {}
  context.kernel.port = undefined
  context.kernel.active = undefined
  context.kernel.failWorker(context.kernel.worker, 'detached worker')
  context.kernel.worker = savedWorker

  const cleanupFailure = new SessionRuntime()
  const cleanupContext = { id: 'scratch-cleanup', callId: 'one' }
  await cleanupFailure.run(cleanupContext, { program: 'return 1', bindings: [] })
  const cleanupDirectory = await cleanupContext.kernel.scratchReady
  cleanupContext.kernel.scratchReady = Promise.reject(new Error('scratch unavailable'))
  void cleanupContext.kernel.scratchReady.catch(() => {})
  await cleanupFailure.dispose()
  await rm(cleanupDirectory, { recursive: true, force: true })

  context.kernel.execute = async () => { throw new Error('tail rejection') }
  await assert.rejects(() => context.kernel.run({}), /tail rejection/)
  await context.kernel.tail
})

test('covers remaining adapter defaults, no-value children, and expired leases', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const assembly = tool => ({ sections: [], tools: [tool] })
  const malformed = [
    { name: 'run_code' },
    { name: 'run_code', parameters: null },
    { name: 'run_code', parameters: { type: 'object' } },
    { name: 'run_code', parameters: { type: 'object', properties: {} } },
    { name: 'run_code', parameters: { type: 'object', properties: { code: { type: 'string' } } } },
  ]
  for (const tool of malformed) await assert.rejects(() => state.assemble(assembly(tool)), /incompatible run_code schema/)

  const cordisFunctions = {
    cordis_inspect_list: async () => ({ providers: [() => {}] }),
    cordis_inspect_query: async args => ({ ...args, data: null }),
    cordis_inspect_self: async () => ({}),
    cordis_define: async () => ({}),
    cordis_run: async () => ({}),
    cordis_stop: async () => ({}),
    cordis_undefine: async () => ({}),
  }
  assert.equal((await state.run('cordis-nonobject', 'return cordis.inspect(null)', cordisFunctions)).error.kind, 'exception')
  assert.equal((await state.run('cordis-nonjson', 'return cordis.inspectList()', cordisFunctions)).error.kind, 'exception')

  cordisFunctions.cordis_inspect_list = async () => ({ providers: [] })
  assert.equal((await state.run('inspect-self-plugin', 'return cordis.inspectSelf({ pluginId: "p" })', cordisFunctions)).error, undefined)
  assert.equal((await state.run('inspect-self-empty', 'return cordis.inspectSelf({})', cordisFunctions)).error, undefined)
  assert.equal((await state.run('inspect-self-package', 'return cordis.inspectSelf({ pluginId: "p", packageId: "x" })', cordisFunctions)).error, undefined)

  const noValue = fixture({}, { upstreamRun: async () => ({ logs: [] }) })
  t.after(() => noValue.dispose())
  assert.deepEqual((await noValue.run('child-no-value', `
return code.run({ code: 'void 0', description: 'No value' })
`)).value, { logs: [] })

  let expired
  const capture = fixture({}, { upstreamRun: async request => {
    expired = request.bindings.find(binding => binding.global === 'host').functions.invoke
    return { logs: [] }
  } })
  t.after(() => capture.dispose())
  await capture.run('capture-expired', `return code.run({ code: 'void 0', description: 'Capture' })`, {
    echo: async value => value,
  })
  assert.throws(() => expired({ name: 'echo', args: null }), /lease expired/)

  const execute = state.listeners.get('tools/execute')[0]
  const invalidBindings = await execute({ name: 'run_code', callId: 'raw', agent: { id: 'raw-bindings' } }, () => (
    state.runtime.run({ program: 'return 1', bindings: null })
  ))
  assert.equal(invalidBindings.error.kind, 'exception')

  const missingFunctions = await execute({ name: 'run_code', callId: 'raw-2', agent: { id: 'raw-functions' } }, () => (
    state.runtime.run({ program: 'return 1', bindings: [{ global: 'tools' }] })
  ))
  assert.equal(missingFunctions.error.kind, 'exception')

  state.runCodeDefinition.output.presentationMeta({}, undefined)
  await state.emit('agent/disposed', { agent: {} })
  state.runCodeDefinition.output.presentationMeta = () => ({ replaced: true })
})

test('covers remaining AST scope and loose replacement forms', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.runDurable('replacement-forms', 'let noInitializer = 1\nvar existingVar = 2')
  assert.equal((await state.run('replacement-forms', 'let noInitializer')).error, undefined)
  assert.equal((await state.run('replacement-forms', 'var existingVar = 3')).error, undefined)
  const result = await state.run('ast-forms', `
function arrayParam([head, ...tail]) { return [head, tail] }
outer: for (const value of [1]) {
  inner: for (;;) {
    if (value) break inner
    continue outer
  }
}
const property = 'platform'
void process[property]
return arrayParam([1, 2])
`)
  assert.equal(result.error, undefined)
})

test('restores an inherited runtime provider without leaving an own patch', async () => {
  const listeners = new Map()
  const cleanups = []
  const inheritedRun = async () => ({ logs: [] })
  const runtime = Object.assign(Object.create({ run: inheritedRun }), {
    language: 'typescript', isolation: 'worker-thread',
  })
  const definition = { name: 'run_code', output: {} }
  const ctx = {
    codeRuntime: runtime,
    tools: { get: () => definition, schemas: () => [] },
    systemPrompt: { section() {} },
    on(name, listener) { listeners.set(name, listener) },
    effect(register) { cleanups.push(register()) },
  }
  apply(ctx)
  assert.equal(Object.hasOwn(runtime, 'run'), true)
  for (const cleanup of cleanups.reverse()) await cleanup()
  assert.equal(Object.hasOwn(runtime, 'run'), false)
  assert.equal(runtime.run, inheritedRun)
})
