import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

function fixture() {
  const listeners = new Map()
  const sections = []
  const cleanups = []
  const runCode = {
    name: 'run_code',
    description: 'Execute a program.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['code', 'description'],
    },
    output: {},
  }
  const runtime = {
    language: 'typescript',
    isolation: 'worker-thread',
    async run() { return { logs: [], value: 'upstream' } },
  }
  const ctx = {
    codeRuntime: runtime,
    tools: {
      get(name) { return name === 'run_code' ? runCode : undefined },
      schemas() {
        return [
          runCode,
          { name: 'read', description: 'Read a bounded page.', parameters: { type: 'object' } },
          { name: 'echo', description: 'Echo a value.', parameters: { type: 'object' } },
        ]
      },
    },
    systemPrompt: {
      section(value) {
        sections.push(value)
        return () => sections.splice(sections.indexOf(value), 1)
      },
    },
    on(name, listener) {
      const values = listeners.get(name) ?? []
      values.push(listener)
      listeners.set(name, values)
      return () => values.splice(values.indexOf(listener), 1)
    },
    effect(register) {
      cleanups.push(register())
    },
  }
  apply(ctx, { computeMs: 500, maxWallMs: 2_000 })

  return {
    ctx,
    runtime,
    listeners,
    sections,
    async execute(program, functions, session = 'native-surface', bindings = undefined) {
      const execute = listeners.get('tools/execute')[0]
      const exec = { name: 'run_code', callId: `${session}-${Date.now()}`, agent: { id: session } }
      let raw
      let result = await execute(exec, async () => {
        raw = await runtime.run({
          program,
          bindings: bindings ?? [{
            global: 'tools',
            functions,
          }],
          signal: new AbortController().signal,
        })
        const meta = runCode.output.presentationMeta?.({}, raw.value)
        return raw.error === undefined
          ? { isError: false, value: raw.value, content: [], meta }
          : { isError: true, content: [], error: { message: raw.error.message }, meta }
      })
      for (const listener of listeners.get('tools/result') ?? []) await listener(exec, result)
      return { raw, result }
    },
    async assemble(assembly) {
      const listener = listeners.get('system-prompt/assemble')[0]
      return listener(assembly, { scope: { id: 'native-surface' } }, async () => assembly)
    },
    async dispose() {
      for (const cleanup of cleanups.reverse()) await cleanup()
    },
  }
}

test('keeps native tools results intact and removes legacy host/workspace projections', async t => {
  const state = fixture()
  t.after(() => state.dispose())

  const bounded = { path: 'a.txt', text: 'page', completeness: 'bounded', totalLines: 9 }
  const observed = await state.execute(
    'return [typeof tools, typeof host, typeof workspace, await tools.read({ file_path: "a.txt" })]',
    { read: async () => bounded },
  )
  assert.deepEqual(observed.raw.value, ['object', 'undefined', 'undefined', bounded])
})

test('expires every captured tools member at the cell boundary', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const functions = { echo: async value => value }

  const captured = await state.execute(
    'const staleEcho = tools.echo\nreturn await tools.echo("live")',
    functions,
    'native-lease',
  )
  assert.equal(captured.raw.value, 'live')
  const expired = await state.execute(
    'try { return await staleEcho("stale") } catch (error) { return error.message }',
    functions,
    'native-lease',
  )
  assert.equal(expired.raw.value, 'PTC execution lease expired')
})

test('preserves exotic native tool names as ordinary own members', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const functions = Object.create(null)
  Object.defineProperty(functions, '__proto__', { enumerable: true, value: async value => value })

  const observed = await state.execute(
    'return await tools["__proto__"]({ retained: true })',
    functions,
    'native-exotic-name',
  )
  assert.deepEqual(observed.raw.value, { retained: true })
})

test('leaves native tool schemas and guidance visible in the prompt assembly', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const assembly = {
    sections: [
      { name: 'tool:read', text: 'Use the read tool for bounded inspection.' },
      { name: 'tool:echo', text: 'Use the echo tool.' },
      { name: 'tools:sdk', text: 'declare const tools: unknown' },
    ],
    contexts: [],
    variables: {},
    tools: [
      state.ctx.tools.get('run_code'),
      { name: 'read', parameters: { type: 'object' } },
      { name: 'echo', parameters: { type: 'object' } },
    ],
  }
  const adapted = await state.assemble(assembly)
  assert.deepEqual(adapted.tools.map(tool => tool.name), ['run_code', 'read', 'echo'])
  assert.deepEqual(adapted.sections.map(section => section.name), ['tool:read', 'tool:echo', 'tools:sdk'])
})

test('exposes descriptive capability exploration with explicit budget and lease boundaries', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const observed = await state.execute(`
const tree = await capabilities.tree()
const staleTree = capabilities.tree
const found = await capabilities.find("read")
const inspected = await capabilities.inspect({ symbols: ["tools.read", "tools.echo"], budget: 1 })
return { tree, found, inspected }
`, { read: async value => value, echo: async value => value }, 'capability-explore')
  assert.deepEqual(observed.raw.value.tree, [{ namespace: 'tools', members: ['echo', 'read'] }])
  assert.equal(observed.raw.value.found[0].symbol, 'tools.read')
  assert.equal(observed.raw.value.found[0].replay, 'recorded-value')
  assert.equal(observed.raw.value.found[0].completeness, 'unknown')
  assert.equal(observed.raw.value.found[0].effect, 'unknown')
  assert.equal(observed.raw.value.inspected.symbols.length, 1)
  assert.equal(observed.raw.value.inspected.symbols[0].completeness, 'unknown')
  assert.equal(observed.raw.value.inspected.symbols[0].effect, 'unknown')
  assert.equal(Object.hasOwn(observed.raw.value.inspected.symbols[0], 'sourceRef'), false)
  assert.deepEqual(observed.raw.value.inspected.unknown, [])
  const invalid = await state.execute('try { await capabilities.inspect(null) } catch (error) { return error.message }', {}, 'capability-invalid')
  assert.match(invalid.raw.value, /expects an object/)
  const expired = await state.execute('try { await staleTree() } catch (error) { return error.message }', {}, 'capability-explore')
  assert.equal(expired.raw.value, 'PTC execution lease expired')
})

test('keeps plugin and owner bindings available when the tool view is empty', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const bindings = [{ global: 'domain', functions: { ping: async () => 'pong' } }]
  const observed = await state.execute(`
return {
  child: await code.run({ code: 'return 1', description: 'Run without tools' }),
  tree: await capabilities.tree(),
  domain: await domain.ping(),
}
`, {}, 'degraded-empty-tools', bindings)
  assert.deepEqual(observed.raw.value, {
    child: { logs: [], result: 'upstream' },
    tree: [{ namespace: 'tools', members: [] }],
    domain: 'pong',
  })
})
