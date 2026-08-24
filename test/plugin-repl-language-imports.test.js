import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appendRunCodeEvents, fixture, ptcAgent } from './plugin-fixture.js'

test('preserves statement boundaries for anonymous default declarations', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const fn = await state.run('default-anonymous-function', [
    'let markers = 0',
    'export default function () {}',
    '(function marker(){ markers += 1 })()',
    'return [typeof __default, markers]',
  ].join('\n'))
  assert.deepEqual(fn.value, ['function', 1])

  const klass = await state.run('default-anonymous-class', [
    'let markers = 0',
    'export default class {}',
    '[1].forEach(() => { markers += 1 })',
    'return [typeof __default, markers]',
  ].join('\n'))
  assert.deepEqual(klass.value, ['function', 1])

  const expression = await state.run(
    'default-expression-continuation', 'export default (() => () => 7)\n()\nreturn __default()',
  )
  assert.equal(expression.value, 7)

  const throwing = await state.runDurable(
    'default-anonymous-position', 'export default function () {}\nthrow new Error("boom")',
  )
  assert.deepEqual(throwing.meta.dshPtcPlus.diagnostics[0].source, {
    cell: 'current', start: { line: 2, column: 7 },
  })
})

test('erases multiline type-only export declarations completely', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const code = [
    'export type Shape = {',
    '  width: number',
    '}',
    'export interface Named {',
    '  name: string',
    '}',
    'export type Simple = string',
    'return 1',
  ].join('\n')
  const result = await state.runDurable('export-type-multiline', code, {}, { session: { events: [] } })
  assert.equal(result.isError, false)
  assert.equal(result.value, 1)
})

test('removes entire inline type-only import specifiers', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const code = [
    "import { type Options, basename } from 'node:path'",
    "import { type Alias as Renamed, join } from 'node:path'",
    "import { dirname, type Extra } from 'node:path'",
    "return [basename('/a/b'), join('/a', 'c'), dirname('/a/d'), typeof Options, typeof Renamed, typeof Extra]",
  ].join('\n')
  const result = await state.runDurable('inline-type-specifier', code, {}, { session: { events: [] } })
  assert.deepEqual(result.value, [
    'b',
    process.platform === 'win32' ? '\\a\\c' : '/a/c',
    '/a',
    'undefined',
    'undefined',
    'undefined',
  ])
})

test('preserves import attributes in rewritten dynamic imports', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  // 模块不存在/属性不匹配是执行期错误（X001），不是解析错误——证明转换
  // 后的语法与 attributes 尾巴都正确
  const code = [
    "import data from './data.json' with { type: 'json' }",
    "import * as ns from 'node:path' with { type: 'x' }",
    'return [typeof data, typeof ns.basename]',
  ].join('\n')
  const result = await state.runDurable('import-attributes', code, {}, { session: { events: [] } })
  assert.equal(result.isError, true)
  assert.doesNotMatch(result.error.message, /PTC-C001/)
  assert.match(result.error.message, /PTC-X001/)
})

test('fails safe when an export shape is unrecognized and when disabled', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const broken = await state.runDurable(
    'export-broken', 'export\nreturn 1', {}, { session: { events: [] } },
  )
  assert.equal(broken.isError, true)
  assert.match(broken.error.message, /PTC-C001/)
  assert.deepEqual(
    await state.run('export-member', 'const o = { export: 7 }\nreturn o.export'),
    { logs: [], value: 7 },
  )
  const bare = await state.runDurable(
    'export-bare', 'export { a, b }', {}, { session: { events: [] } },
  )
  assert.equal(bare.isError, true)
  assert.match(bare.error.message, /PTC-C001/)
  const malformedType = await state.runDurable(
    'export-malformed', 'export type Bad = }', {}, { session: { events: [] } },
  )
  assert.equal(malformedType.isError, true)
  assert.match(malformedType.error.message, /PTC-C001/)
  const semiType = await state.runDurable(
    'export-malformed', 'export type Simple = string;\nreturn 1', {}, { session: { events: [] } },
  )
  assert.equal(semiType.isError, false)
  assert.equal(semiType.value, 1)
  const inlineType = await state.runDurable(
    'export-malformed', 'export type Shape = { a: number }', {}, { session: { events: [] } },
  )
  assert.equal(inlineType.isError, false)
  const openAttributes = await state.runDurable(
    'export-malformed', "import x from 'node:util' with { a: 1\nreturn 1", {}, { session: { events: [] } },
  )
  assert.equal(openAttributes.isError, true)
  assert.match(openAttributes.error.message, /PTC-C001/)
  for (const shape of ['export default class NoBody', 'export default']) {
    const rejected = await state.runDurable('export-malformed', shape, {}, { session: { events: [] } })
    assert.equal(rejected.isError, true)
    assert.match(rejected.error.message, /PTC-C001/)
  }
  const typeSideEffect = await state.runDurable(
    'export-type-side', "import type 'node:util'\nreturn 1", {}, { session: { events: [] } },
  )
  assert.equal(typeSideEffect.isError, true)
  assert.match(typeSideEffect.error.message, /PTC-C001/)
  const badAttributes = await state.runDurable(
    'export-bad-attrs', "import x from 'node:util' whatever\nreturn 1", {}, { session: { events: [] } },
  )
  assert.equal(badAttributes.isError, true)
  assert.match(badAttributes.error.message, /PTC-C001/)
  const disabled = fixture({ autoStripExports: false })
  t.after(() => disabled.dispose())
  const rejected = await disabled.runDurable(
    'export-disabled', 'export const value = 1\nreturn value', {}, { session: { events: [] } },
  )
  assert.equal(rejected.isError, true)
  assert.match(rejected.error.message, /PTC-C001/)
})

test('surfaces binding continuity after a rewritten cell', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const codeOnlyAssembly = {
    sections: [
      { name: 'tools:code-only', text: '`run_code` is the only tool you can call directly.' },
      { name: 'tools:sdk', text: 'declare const tools: unknown' },
    ],
    contexts: [], variables: {}, tools: [state.runCodeDefinition],
  }
  const session = { id: 'export-feedback-session', events: [{ type: 'turn/start' }] }
  const agent = ptcAgent(`${session.id}-agent`, session)
  const code = 'export const exportedValue = 1\nreturn exportedValue'
  const observed = await state.runDurable(session.id, code, {}, { session })
  appendRunCodeEvents(session.events, 'export-feedback-cell', code, observed)
  const assembly = await state.assemble(codeOnlyAssembly, { agent, scope: agent, signal: new AbortController().signal })
  const entries = assembly.contexts.filter(item => item?.name === 'tools:ptc-plus-rewrite-info')
  assert.equal(entries.length, 1)
  assert.match(entries[0].text, /completed after these source adjustments/)
  assert.match(entries[0].text, /stripped the export modifier from a top-level declaration/)
  assert.match(entries[0].text, /reusing its ordinary top-level bindings/)
  const reexportCode = "export { basename } from 'node:path'\nreturn 1"
  const reexport = await state.runDurable(session.id, reexportCode, {}, { session })
  appendRunCodeEvents(session.events, 'export-feedback-reexport', reexportCode, reexport)
  const updated = await state.assemble(codeOnlyAssembly, { agent, scope: agent, signal: new AbortController().signal })
  const updatedEntries = updated.contexts.filter(item => item?.name === 'tools:ptc-plus-rewrite-info')
  assert.equal(updatedEntries.length, 1)
  assert.match(updatedEntries[0].text, /converted the re-export of "node:path" into a side-effect import/)

  const erasedCode = "import type { A } from 'pkg'\nexport type B = A\nreturn 1"
  const erased = await state.runDurable(session.id, erasedCode, {}, { session })
  appendRunCodeEvents(session.events, 'export-feedback-erased', erasedCode, erased)
  const erasedAssembly = await state.assemble(codeOnlyAssembly, { agent, scope: agent, signal: new AbortController().signal })
  const erasedEntries = erasedAssembly.contexts.filter(item => item?.name === 'tools:ptc-plus-rewrite-info')
  assert.equal(erasedEntries.length, 1)
  assert.match(erasedEntries[0].text, /removed the type-only import of "pkg"/)
  assert.match(erasedEntries[0].text, /removed a type-only export declaration/)
  assert.match(erasedEntries[0].text, /do not resend its source/)

  // A plain cell clears the snapshot; a split redeclaration then surfaces its
  // own rewrite text.
  const plain = await state.runDurable(session.id, 'const mixExisting = 1', {}, { session })
  appendRunCodeEvents(session.events, 'export-feedback-plain', 'const mixExisting = 1', plain)
  const cleared = await state.assemble(codeOnlyAssembly, { agent, scope: agent, signal: new AbortController().signal })
  assert.equal(cleared.contexts.some(item => item?.name === 'tools:ptc-plus-rewrite-info'), false)
  const splitCode = 'const { mixExisting, mixNew } = { mixExisting: 2, mixNew: 3 }\nreturn mixNew'
  const split = await state.runDurable(session.id, splitCode, {}, { session })
  appendRunCodeEvents(session.events, 'export-feedback-split', splitCode, split)
  const splitAssembly = await state.assemble(codeOnlyAssembly, { agent, scope: agent, signal: new AbortController().signal })
  const splitEntries = splitAssembly.contexts.filter(item => item?.name === 'tools:ptc-plus-rewrite-info')
  assert.equal(splitEntries.length, 1)
  assert.match(splitEntries[0].text, /split a mixed top-level declaration/)
  assert.match(splitEntries[0].text, /reusing its ordinary top-level bindings/)
})

test('classifies require exactly like dynamic imports', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const durable = await state.runDurable(
    'require-util', "const { inspect } = require('node:util')\nreturn typeof inspect", {}, { session: { events: [] } },
  )
  assert.equal(durable.meta.dshPtcPlus.status, 'durable')
  assert.deepEqual(
    await state.run('require-util', 'return inspect([])'),
    { logs: [], value: '[]' },
  )
  const volatile = await state.runDurable(
    'require-util', "const { basename } = require('node:path')\nreturn basename('/a/b')", {}, { session: { events: [] } },
  )
  assert.equal(volatile.meta.dshPtcPlus.status, 'volatile')
  assert.match(volatile.meta.dshPtcPlus.volatileReason, /module node:path/)
  const dynamic = await state.runDurable(
    'require-dynamic', 'const specifier = "node:path"\nconst mod = require(specifier)\nreturn typeof mod', {}, { session: { events: [] } },
  )
  assert.equal(dynamic.meta.dshPtcPlus.status, 'volatile')
  assert.match(dynamic.meta.dshPtcPlus.volatileReason, /dynamic module resolution/)
})

test('preflights forbidden kernel-control requires', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const result = await state.runDurable(
    'require-forbidden', "const { parentPort } = require('node:worker_threads')\nreturn 1", {}, { session: { events: [] } },
  )
  assert.equal(result.isError, true)
  assert.match(result.error.message, /PTC-C002/)
  assert.match(result.error.message, /cell import of node:worker_threads is forbidden/)
})

test('does not infer retry safety from durable replayability', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const durable = await state.runDurable(
    'retryable-err', 'const missing = undefined\nreturn missing.value', {}, { session: { events: [] } },
  )
  assert.equal(durable.isError, true)
  assert.doesNotMatch(durable.error.message, /retrying it is safe/)
  assert.doesNotMatch(durable.error.message, /no external side effects/)
  const volatile = await state.runDurable(
    'volatile-err', "const { basename } = require('node:path')\nreturn basename(undefined)", {}, { session: { events: [] } },
  )
  assert.equal(volatile.isError, true)
  assert.doesNotMatch(volatile.error.message, /no external side effects/)
})

test('preflights forbidden rewritten imports', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const result = await state.runDurable(
    'forbidden-import', "import { parentPort } from 'node:worker_threads'\nreturn 1", {}, { session: { events: [] } },
  )
  assert.equal(result.isError, true)
  assert.match(result.error.message, /PTC-C002/)
  assert.match(result.error.message, /cell import of node:worker_threads is forbidden/)
})

test('executes rewritten imports after a semicolonless directive prologue', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const result = await state.runDurable(
    'semicolonless-directive-import',
    `"use strict"
import { inspect } from 'node:util'
const strictThis = (function () { return this })()
return [strictThis === undefined, inspect({ value: 1 })]`,
    {},
    { session: { events: [] } },
  )
  assert.equal(result.isError, false)
  assert.deepEqual(result.value, [true, '{ value: 1 }'])
})

test('fails safe when a static import shape is unrecognized', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const broken = await state.runDurable(
    'broken-import', "import fs from\nreturn 1", {}, { session: { events: [] } },
  )
  assert.equal(broken.isError, true)
  assert.match(broken.error.message, /PTC-C001/)
  const noFrom = await state.runDurable(
    'broken-import', "import { a } from\nreturn 1", {}, { session: { events: [] } },
  )
  assert.equal(noFrom.isError, true)
  assert.match(noFrom.error.message, /PTC-C001/)
  for (const shape of ["import { a }", 'import x y', 'import { a b']) {
    const rejected = await state.runDurable('broken-import', `${shape}\nreturn 1`, {}, { session: { events: [] } })
    assert.equal(rejected.isError, true)
    assert.match(rejected.error.message, /PTC-C001/)
  }
  const nullByte = await state.runDurable(
    'broken-import', `const value = 1${String.fromCharCode(0)}\nreturn 1`, {}, { session: { events: [] } },
  )
  assert.equal(nullByte.isError, true)
  assert.match(nullByte.error.message, /PTC-C001/)
  const metaAccess = await state.runDurable(
    'import-meta', 'return import.meta.url', {}, { session: { events: [] } },
  )
  assert.equal(metaAccess.isError, true)
  assert.match(metaAccess.error.message, /PTC-C001/)
  assert.deepEqual(
    await state.run('member-import', 'const o = { import: 7 }\nreturn o.import'),
    { logs: [], value: 7 },
  )
})

test('keeps static imports rejected when autoRewriteImports is disabled', async (t) => {
  const state = fixture({ autoRewriteImports: false })
  t.after(() => state.dispose())
  const result = await state.runDurable(
    'no-rewrite', "import fs from 'node:fs'\nreturn 1", {}, { session: { events: [] } },
  )
  assert.equal(result.isError, true)
  assert.match(result.error.message, /PTC-C001/)
})

test('attaches rewrite provenance to failed executions', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const result = await state.runDurable(
    'rewrite-throw', "import { basename } from 'node:path'; throw new Error('boom')", {}, { session: { events: [] } },
  )
  assert.equal(result.isError, true)
  assert.match(result.error.message, /boom/)
  assert.equal(result.meta.dshPtcPlusRewrites.length, 1)
  assert.equal(result.meta.dshPtcPlusRewrites[0].kind, 'import')
  assert.deepEqual(result.meta.dshPtcPlus.diagnostics[0].source, {
    cell: 'current', start: { line: 1, column: 45 },
  })
})

test('does not attach rewrite provenance to preflight-rejected cells', async (t) => {
  const state = fixture({ looseTopLevelRedeclarations: false })
  t.after(() => state.dispose())
  await state.runDurable('strict-rewrite', 'const existingValue = 1', {}, { session: { events: [] } })
  const rejected = await state.runDurable(
    'strict-rewrite', "import { basename } from 'node:path'\nconst existingValue = 2\nreturn 1", {}, { session: { events: [] } },
  )
  assert.equal(rejected.isError, true)
  assert.match(rejected.error.message, /PTC-N001/)
  assert.equal(rejected.meta.dshPtcPlusRewrites, undefined)
})
