import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalizeToolCallStream } from '../internal/tool-call-canonicalizer.js'

async function collect(chunks, options = {}) {
  const result = []
  for await (const chunk of canonicalizeToolCallStream((async function* () {
    yield* chunks
  })(), options)) result.push(chunk)
  return result
}

function call(name, args, options = {}) {
  const id = options.id ?? 'call-1'
  const raw = typeof args === 'string' ? args : JSON.stringify(args)
  const split = options.split ?? raw.length
  const chunks = [
    { type: 'block-start', index: options.index ?? 0, blockType: 'tool-call' },
    {
      type: 'tool-call-delta', index: options.index ?? 0, id, name,
      argumentsDelta: raw.slice(0, split),
    },
  ]
  if (split < raw.length) chunks.push({
    type: 'tool-call-delta', index: options.index ?? 0, id, name,
    argumentsDelta: raw.slice(split),
  })
  if (options.withEnd !== false) chunks.push({
    type: 'block-end', index: options.index ?? 0,
    block: { type: 'tool-call', id, name, arguments: raw },
  })
  chunks.push({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } })
  chunks.push({ type: 'finish', reason: { kind: 'tool-calls' } })
  return chunks
}

function schemas(...names) {
  return new Map(names.map(name => [name, { name, parameters: { type: 'object' } }]))
}

test('canonicalizes every live native name through its typed tools binding', async () => {
  for (const [name, args] of [
    ['read', { file_path: 'README.md', limit: 5 }],
    ['todo_write', { todos: [] }],
    ['future_tool', { future_field: true }],
    ['__proto__', null],
  ]) {
    const chunks = await collect(call(name, args, { split: 2 }), {
      tools: [{ name: 'run_code' }],
      nativeSchemas: schemas('read', 'todo_write', 'future_tool', '__proto__'),
    })
    const delta = chunks.find(chunk => chunk.type === 'tool-call-delta')
    assert.equal(delta.name, 'run_code')
    const generated = JSON.parse(delta.argumentsDelta)
    assert.ok(generated.code.includes(`tools[${JSON.stringify(name)}]`))
    assert.match(generated.code, /JSON\.parse/)
    assert.equal(generated.description, `Call ${name} inside the session REPL`)
    assert.equal(chunks.filter(chunk => chunk.type === 'tool-call-delta').length, 1)
    assert.deepEqual(chunks.find(chunk => chunk.type === 'block-end').block, {
      type: 'tool-call', id: 'call-1', name: 'run_code', arguments: delta.argumentsDelta,
    })
  }

  const withoutStart = call('read', { file_path: 'README.md' })
    .filter(chunk => chunk.type !== 'block-start')
  const transformed = await collect(withoutStart, {
    tools: [{ name: 'run_code' }], nativeSchemas: schemas('read'),
  })
  assert.equal(transformed.find(chunk => chunk.type === 'tool-call-delta').name, 'run_code')
})

test('edits one exact fragment of rejected source without model-side source re-emission', async () => {
  const repairSource = `const payload = ${JSON.stringify('a'.repeat(20_000))}\nreturn payload.lenght`
  const raw = JSON.stringify({ old_string: 'lenght', new_string: 'length' })
  const transformed = await collect(call('edit_run_code', raw), {
    tools: [{ name: 'run_code' }, { name: 'edit_run_code' }],
    nativeSchemas: new Map(),
    editToolName: 'edit_run_code',
    repairSource,
  })
  const delta = transformed.find(chunk => chunk.type === 'tool-call-delta')
  assert.equal(delta.name, 'run_code')
  const generated = JSON.parse(delta.argumentsDelta)
  assert.equal(generated.description, 'Edit and run rejected TypeScript cell')
  assert.equal(generated.code, repairSource.replace('lenght', 'length'))
  assert.ok(raw.length < generated.code.length / 100)
})

test('declines unavailable or ambiguous code edits without a PTC failure', async () => {
  for (const [args, repairSource, reason] of [
    [null, 'return 1', /expects old_string/],
    [{ old_string: 'x', new_string: 'y' }, undefined, /no run_code cell/],
    [{ old_string: 'x', new_string: 'y' }, 'return 1', /not found/],
    [{ old_string: 'x', new_string: 'y' }, 'x + x', /more than once/],
    [{ old_string: '', new_string: 'y' }, 'x', /non-empty/],
    [{ old_string: 'x', new_string: 'x' }, 'x', /must differ/],
    [{ old_string: 'x', new_string: 'y', extra: true }, 'x', /exactly/],
  ]) {
    const transformed = await collect(call('edit_run_code', args), {
      tools: [{ name: 'run_code' }, { name: 'edit_run_code' }],
      nativeSchemas: new Map(), editToolName: 'edit_run_code', repairSource,
    })
    const generated = JSON.parse(transformed.find(chunk => chunk.type === 'tool-call-delta').argumentsDelta)
    assert.equal(generated.description, 'Reject unavailable run_code edit')
    assert.match(generated.code, reason)
    assert.match(generated.code, /edited/)
  }
})

test('accepts a provisional empty call id when the final block supplies identity', async () => {
  const source = call('edit_run_code', { old_string: '1', new_string: '2' })
  source.find(chunk => chunk.type === 'tool-call-delta').id = ''
  const transformed = await collect(source, {
    tools: [{ name: 'run_code' }, { name: 'edit_run_code' }],
    nativeSchemas: new Map(), editToolName: 'edit_run_code', repairSource: 'return 1',
  })
  assert.equal(transformed.find(chunk => chunk.type === 'tool-call-delta').name, 'run_code')
  assert.equal(transformed.find(chunk => chunk.type === 'block-end').block.id, 'call-1')
})

test('preserves unrelated content, accounting, and call ids while invalidating provider replay', async () => {
  const source = [
    { type: 'text-delta', index: 7, text: 'before' },
    ...call('read', { file_path: 'a' }, { id: 'stable-id', index: 2 }),
  ]
  source.splice(3, 0, { type: 'provider-metadata', index: 9, value: 'preserved' })
  source.splice(4, 0, { type: 'provider-metadata', index: 2, value: 'same-index' })
  source[source.length - 1] = {
    ...source.at(-1),
    replayState: { response: { opaque: true }, blocks: [{ opaque: true }] },
  }
  const transformed = await collect(source, {
    tools: [{ name: 'run_code' }], nativeSchemas: schemas('read'),
  })
  assert.equal(transformed[0].text, 'before')
  assert.equal(transformed.find(chunk => chunk.type === 'tool-call-delta').id, 'stable-id')
  assert.deepEqual(
    transformed.filter(chunk => chunk.type === 'provider-metadata').map(chunk => chunk.value),
    ['preserved', 'same-index'],
  )
  assert.ok(transformed.some(chunk => chunk.type === 'usage'))
  assert.equal(Object.hasOwn(transformed.at(-1), 'replayState'), false)
})

test('rewrites multiple known calls without touching unknown calls', async () => {
  const source = [
    ...call('read', { file_path: 'a' }, { index: 0 }).slice(0, -2),
    ...call('unknown', { value: 1 }, { index: 1 }).slice(0, -2),
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const transformed = await collect(source, {
    tools: [{ name: 'run_code' }], nativeSchemas: schemas('read'),
  })
  const ends = transformed.filter(chunk => chunk.type === 'block-end')
  assert.equal(ends[0].block.name, 'run_code')
  assert.equal(ends[1].block.name, 'unknown')
})

test('rewrites interleaved parallel calls when final JSON only differs in serialization', async () => {
  const source = [
    { type: 'text-delta', index: 0, text: 'Inspecting runtime files.' },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'glob-1', name: 'glob', argumentsDelta: '' },
    { type: 'tool-call-delta', index: 1, id: 'glob-1', name: 'glob', argumentsDelta: '{"pattern": "package.json"}' },
    { type: 'block-start', index: 2, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 2, id: 'glob-2', name: 'glob', argumentsDelta: '{"pattern": ".nvmrc"}' },
    { type: 'block-start', index: 3, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 3, id: 'glob-3', name: 'glob', argumentsDelta: '{"pattern": ".node-version"}' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Inspecting runtime files.' } },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'glob-1', name: 'glob', arguments: '{"pattern":"package.json"}' } },
    { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'glob-2', name: 'glob', arguments: '{"pattern":".nvmrc"}' } },
    { type: 'block-end', index: 3, block: { type: 'tool-call', id: 'glob-3', name: 'glob', arguments: '{"pattern":".node-version"}' } },
    { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { provider: 'opaque' } },
  ]
  const transformed = await collect(source, {
    tools: [{ name: 'run_code' }], nativeSchemas: schemas('glob'),
  })
  assert.deepEqual(
    transformed.filter(chunk => chunk.type === 'tool-call-delta').map(chunk => chunk.name),
    ['run_code', 'run_code', 'run_code'],
  )
  assert.deepEqual(
    transformed.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
      .map(chunk => chunk.block.name),
    ['run_code', 'run_code', 'run_code'],
  )
  assert.equal(Object.hasOwn(transformed.at(-1), 'replayState'), false)
})

test('preserves authoritative JSON spelling while comparing values iteratively', async () => {
  const depth = 5_000
  const deep = `${'['.repeat(depth)}-0${']'.repeat(depth)}`
  for (const raw of ['{"value":-0}', '{"value":1e400}', deep]) {
    const transformed = await collect(call('probe', raw), {
      tools: [{ name: 'run_code' }], nativeSchemas: schemas('probe'),
    })
    const generated = JSON.parse(transformed.find(chunk => chunk.type === 'tool-call-delta').argumentsDelta)
    assert.ok(generated.code.includes(JSON.stringify(raw)))
  }
})

test('rewrites delta-only and interleaved no-start calls before finish', async () => {
  const deltaOnly = [
    { type: 'tool-call-delta', index: 0, id: 'read-only', name: 'read', argumentsDelta: '{}' },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { opaque: true } },
  ]
  const finalized = await collect(deltaOnly, {
    tools: [{ name: 'run_code' }], nativeSchemas: schemas('read'),
  })
  assert.equal(finalized[0].name, 'run_code')
  assert.equal(Object.hasOwn(finalized.at(-1), 'replayState'), false)

  const interleaved = [
    { type: 'tool-call-delta', index: 1, id: 'read-a', name: 'read', argumentsDelta: '{}' },
    { type: 'tool-call-delta', index: 2, id: 'glob-b', name: 'glob', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'read-a', name: 'read', arguments: '{}' } },
    { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'glob-b', name: 'glob', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { opaque: true } },
  ]
  const transformed = await collect(interleaved, {
    tools: [{ name: 'run_code' }], nativeSchemas: schemas('read', 'glob'),
  })
  assert.deepEqual(
    transformed.filter(chunk => chunk.type === 'tool-call-delta').map(chunk => chunk.name),
    ['run_code', 'run_code'],
  )
  assert.deepEqual(
    transformed.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block.name),
    ['run_code', 'run_code'],
  )
})

test('passes through calls when transport or identity is not proven', async () => {
  const source = call('read', { file_path: 'a' })
  const cases = [
    { enabled: false, tools: [{ name: 'run_code' }], nativeSchemas: schemas('read') },
    { tools: [{ name: 'run_code' }, { name: 'read' }], nativeSchemas: schemas('read') },
    { tools: undefined, nativeSchemas: schemas('read') },
    { tools: [{ name: 'other' }], nativeSchemas: schemas('read') },
    { tools: [{ name: 'run_code' }], nativeSchemas: undefined },
    { tools: [{ name: 'run_code' }], nativeSchemas: schemas('run_code') },
    { tools: [{ name: 'run_code' }], nativeSchemas: schemas('unknown') },
    {
      tools: [{ name: 'run_code' }, { name: 'edit_run_code' }, { name: 'extra' }],
      nativeSchemas: schemas('read'), editToolName: 'edit_run_code',
    },
  ]
  for (const options of cases) assert.deepEqual(await collect(source, options), source)
})

test('passes through malformed and internally inconsistent tool blocks byte-for-byte', async () => {
  const malformed = call('read', '{', { withEnd: false })
  const completeInvalidJson = call('read', '{')
  const missingId = call('read', {}).map(chunk => chunk.type === 'tool-call-delta'
    ? { ...chunk, id: undefined }
    : chunk)
  const inconsistentId = call('read', {}).map(chunk => chunk.type === 'block-end'
    ? { ...chunk, block: { ...chunk.block, id: 'different' } }
    : chunk)
  const inconsistentName = call('read', {}).map(chunk => chunk.type === 'block-end'
    ? { ...chunk, block: { ...chunk.block, name: 'different' } }
    : chunk)
  const inconsistentArguments = call('read', {}).map(chunk => chunk.type === 'block-end'
    ? { ...chunk, block: { ...chunk.block, arguments: '{"different":true}' } }
    : chunk)
  const invalidDelta = call('read', {}).map(chunk => chunk.type === 'tool-call-delta'
    ? { ...chunk, argumentsDelta: undefined }
    : chunk)
  const invalidEnd = call('read', {}).map(chunk => chunk.type === 'block-end'
    ? { ...chunk, block: { ...chunk.block, arguments: undefined } }
    : chunk)
  const noDelta = call('read', {}).filter(chunk => chunk.type !== 'tool-call-delta')
  for (const source of [
    malformed, completeInvalidJson, missingId, inconsistentId, inconsistentName,
    inconsistentArguments, invalidDelta, invalidEnd, noDelta,
  ]) {
    assert.deepEqual(await collect(source, {
      tools: [{ name: 'run_code' }], nativeSchemas: schemas('read'),
    }), source)
  }
})

test('keeps untouched provider replay metadata authoritative', async () => {
  const source = call('unknown', {})
  source[source.length - 1] = {
    ...source.at(-1),
    replayState: { response: { provider: 'opaque' }, blocks: [] },
  }
  assert.deepEqual(await collect(source, {
    tools: [{ name: 'run_code' }], nativeSchemas: schemas('read'),
  }), source)
})

test('streams ordinary text and legal run_code blocks before the response completes', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const source = async function* () {
    yield { type: 'text-delta', index: 0, text: 'visible now' }
    yield { type: 'block-start', index: 1, blockType: 'tool-call' }
    yield {
      type: 'tool-call-delta', index: 1, id: 'legal', name: 'run_code',
      argumentsDelta: '{"code":"return 1","description":"Return one"}',
    }
    await gate
    yield {
      type: 'block-end', index: 1,
      block: {
        type: 'tool-call', id: 'legal', name: 'run_code',
        arguments: '{"code":"return 1","description":"Return one"}',
      },
    }
  }
  const iterator = canonicalizeToolCallStream(source(), {
    tools: [{ name: 'run_code' }], nativeSchemas: schemas('read'),
  })[Symbol.asyncIterator]()
  assert.deepEqual(await iterator.next(), {
    done: false, value: { type: 'text-delta', index: 0, text: 'visible now' },
  })
  assert.equal((await iterator.next()).value.type, 'block-start')
  assert.equal((await iterator.next()).value.name, 'run_code')
  release()
  assert.equal((await iterator.next()).value.type, 'block-end')
  assert.equal((await iterator.next()).done, true)
})

test('flushes an incomplete candidate unchanged before propagating a stream failure', async () => {
  const failure = new Error('provider failed')
  const source = async function* () {
    yield { type: 'text-delta', index: 0, text: 'kept' }
    yield { type: 'block-start', index: 1, blockType: 'tool-call' }
    yield {
      type: 'tool-call-delta', index: 1, id: 'partial', name: 'read',
      argumentsDelta: '{"file_path":"partial',
    }
    throw failure
  }
  const observed = []
  await assert.rejects(async () => {
    for await (const chunk of canonicalizeToolCallStream(source(), {
      tools: [{ name: 'run_code' }], nativeSchemas: schemas('read'),
    })) observed.push(chunk)
  }, error => error === failure)
  assert.deepEqual(observed.map(chunk => chunk.type), [
    'text-delta', 'block-start', 'tool-call-delta',
  ])
  assert.equal(observed[2].name, 'read')
})
