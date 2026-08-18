import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { canonicalizeToolCallStream } from '../internal/tool-call-canonicalizer.js'

const observed = JSON.parse(readFileSync(new URL('./fixtures/model-tool-call-antipatterns.json', import.meta.url), 'utf8'))

async function collect(chunks, options = {}) {
  const result = []
  for await (const chunk of canonicalizeToolCallStream((async function* () {
    yield* chunks
  })(), options)) result.push(chunk)
  return result
}

function call(name, args, withEnd = true) {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call-1', name, argumentsDelta: JSON.stringify(args) },
  ]
  if (withEnd) chunks.push({
    type: 'block-end', index: 0,
    block: { type: 'tool-call', id: 'call-1', name, arguments: JSON.stringify(args) },
  })
  chunks.push({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } })
  chunks.push({ type: 'finish', reason: { kind: 'tool-calls' } })
  return chunks
}

function schemas(...names) {
  return new Map(names.map(name => [name, { name, parameters: { type: 'object' } }]))
}

test('canonicalizes native and program-shaped calls into one run_code call', async () => {
  const cases = [
    ['read', { file_path: 'README.md', offset: 2, limit: 3 }],
    ['glob', { pattern: 'src/*.js', path: '.' }],
    ['write', { file_path: 'a.txt', content: 'x' }],
    ['edit', { file_path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true }],
    ['workspace.readLines', { path: 'README.md', limit: 4 }],
    ['workspace.findFiles', { pattern: 'src/*.js' }],
    ['host.invoke', { name: 'read', args: { file_path: 'README.md' } }],
    ['code.run', { code: 'return 1', description: 'Compute one' }],
    ['repl.state', { action: 'list' }],
    ...observed.cases.map(item => [item.outerName, item.arguments]),
  ]
  for (const [name, args] of cases) {
    const chunks = await collect(call(name, args), {
      tools: [{ name: 'run_code' }],
      nativeSchemas: schemas('read', 'glob', 'write', 'edit', 'skill', 'todo_write'),
    })
    const delta = chunks.find(chunk => chunk.type === 'tool-call-delta')
    assert.equal(delta.name, 'run_code')
    const generated = JSON.parse(delta.argumentsDelta)
    assert.equal(typeof generated.code, 'string')
    assert.match(generated.code, /PTC Plus/)
    assert.deepEqual(chunks.find(chunk => chunk.type === 'block-end').block, {
      type: 'tool-call', id: 'call-1', name: 'run_code', arguments: delta.argumentsDelta,
    })
  }
})

test('preserves call id and non-tool chunks while dropping stale provider replay state', async () => {
  const chunks = [
    { type: 'text-delta', index: 1, text: 'before' },
    ...call('read', { file_path: 'a' }, false),
  ]
  chunks[chunks.length - 1] = {
    ...chunks[chunks.length - 1],
    replayState: { response: { opaque: true }, blocks: [{ opaque: true }] },
  }
  const transformed = await collect(chunks, { tools: [{ name: 'run_code' }], nativeSchemas: schemas('read') })
  assert.equal(transformed[0].text, 'before')
  assert.equal(transformed.filter(chunk => chunk.type === 'tool-call-delta')[0].id, 'call-1')
  assert.equal(transformed.filter(chunk => chunk.type === 'tool-call-delta')[0].name, 'run_code')
  assert.ok(transformed.some(chunk => chunk.type === 'usage'))
  assert.equal(Object.hasOwn(transformed.at(-1), 'replayState'), false)
})

test('preserves provider replay state byte-for-byte when no call is rewritten', async () => {
  const replayState = {
    response: {
      kind: 'pi-ai', version: 2, api: 'openai-completions',
      provider: 'opencode-go', model: 'deepseek-v4-flash', stopReason: 'toolUse',
    },
    blocks: [{ type: 'tool-call', thoughtSignature: 'opaque' }],
  }
  const source = call('unknown', {})
  source[source.length - 1] = { ...source.at(-1), replayState }
  assert.deepEqual(await collect(source, {
    tools: [{ name: 'run_code' }], nativeSchemas: schemas('read'),
  }), source)
})

test('leaves non-strict, disabled, unknown, malformed, and incomplete calls unchanged', async () => {
  const source = call('read', { file_path: 'a' })
  assert.deepEqual(await collect(source, { tools: [{ name: 'run_code' }, { name: 'read' }] }), source)
  assert.deepEqual(await collect(source, { enabled: false, tools: [{ name: 'run_code' }] }), source)
  assert.deepEqual(await collect(call('unknown', {}), { tools: [{ name: 'run_code' }] }), call('unknown', {}))
  const nativeFallback = await collect(call('read', { file_path: 'a', extra: true }), {
    tools: [{ name: 'run_code' }], nativeSchemas: schemas('read'),
  })
  const fallbackCode = JSON.parse(nativeFallback[1].argumentsDelta).code
  assert.match(fallbackCode, /host\.invoke\(\{ name: "read"/)
  assert.match(fallbackCode, /extra/)
  const malformedJson = call('read', { file_path: 'a' }, false)
    .map(chunk => chunk.type === 'tool-call-delta' ? { ...chunk, argumentsDelta: '{' } : chunk)
  assert.deepEqual(await collect(malformedJson, {
    tools: [{ name: 'run_code' }], nativeSchemas: schemas('read'),
  }), malformedJson)
  const noId = call('read', { file_path: 'a' }).map(chunk => chunk.type === 'tool-call-delta' ? { ...chunk, id: undefined } : chunk)
  assert.deepEqual(await collect(noId, { tools: [{ name: 'run_code' }] }), noId)
  const inconsistent = call('read', { file_path: 'a' }).map(chunk => chunk.type === 'block-end'
    ? { ...chunk, block: { ...chunk.block, arguments: '{"file_path":"different"}' } }
    : chunk)
  assert.deepEqual(await collect(inconsistent, { tools: [{ name: 'run_code' }] }), inconsistent)
  const hostMissingArgs = await collect(call('host.invoke', { name: 'read' }), {
    tools: [{ name: 'run_code' }], nativeSchemas: schemas('read'),
  })
  assert.equal(hostMissingArgs[1].name, 'host.invoke')
})

test('uses the live schema map for future native tools and preserves new fields', async () => {
  const nativeSchemas = new Map([['future_search', {
    name: 'future_search',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string' }, mode: { type: 'string' } },
    },
  }]])
  const transformed = await collect(call('future_search', { query: 'x', mode: 'semantic' }), {
    tools: [{ name: 'run_code' }], nativeSchemas,
  })
  const generated = JSON.parse(transformed[1].argumentsDelta)
  assert.match(generated.code, /host\.invoke/)
  assert.match(generated.code, /semantic/)
})

test('only upgrades read when its live schema still matches the projection', async () => {
  const compatible = new Map([['read', {
    name: 'read',
    parameters: {
      file_path: { type: 'string', required: true },
      offset: { type: 'number' },
      limit: { type: 'number' },
    },
  }]])
  const upgraded = await collect(call('read', { file_path: 'a' }), {
    tools: [{ name: 'run_code' }], nativeSchemas: compatible,
  })
  assert.match(JSON.parse(upgraded[1].argumentsDelta).code, /workspace\.readLines/)
  const changed = new Map([['read', {
    name: 'read',
    parameters: {
      file_path: { type: 'string', required: true },
      encoding: { type: 'string', required: true },
    },
  }]])
  const preserved = await collect(call('read', { file_path: 'a' }), {
    tools: [{ name: 'run_code' }], nativeSchemas: changed,
  })
  assert.match(JSON.parse(preserved[1].argumentsDelta).code, /host\.invoke\(\{ name: "read"/)
})

test('accepts the JSON-schema form of a compatible glob contract', async () => {
  const nativeSchemas = new Map([['glob', {
    name: 'glob',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' } },
      required: ['pattern'],
    },
  }]])
  const transformed = await collect(call('glob', { pattern: '*.js' }), {
    tools: [{ name: 'run_code' }], nativeSchemas,
  })
  assert.match(JSON.parse(transformed[1].argumentsDelta).code, /workspace\.findFiles/)
})

test('never treats the run_code transport as a native capability', async () => {
  const source = call('run_code', { code: 'return 1', description: 'one' })
  assert.deepEqual(await collect(source, {
    tools: [{ name: 'run_code' }], nativeSchemas: schemas('run_code'),
  }), source)
})
