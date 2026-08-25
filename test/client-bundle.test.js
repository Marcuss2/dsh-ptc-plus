import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)

test('keeps generated client bundle checkout bytes stable', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const attribute = execFileSync('git', ['check-attr', 'eol', '--', 'client.js'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  assert.equal(attribute, 'client.js: eol: lf')
})

test('checked client bundle is loadable through the DSH module loader contract', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const sourceModule = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const registrations = []
  const window = { __ModuleLoader__: { load(value) { registrations.push(value) } } }
  runInNewContext(source, { window })
  assert.equal(registrations.length, 1)
  const loaded = registrations[0]
  assert.equal(loaded.id, packageJson.name)
  const React = { createElement() {}, useState() {}, useRef() {}, useCallback(value) { return value }, useSyncExternalStore() {}, useEffect() {} }
  const primitives = {
    IconCheckOutline14() {},
    IconChevronDownOutline14() {},
    IconSettingsOutline16() {},
  }
  const exported = loaded.factory(name => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected client dependency ${name}`)
  })
  assert.equal(Array.from(exported.inject).join(','), 'settingsScope,slots,sessions')
  assert.equal(typeof exported.apply, 'function')
  assert.match(source, /settings\.plugin\.item/)
  assert.match(source, /conversation\.session\.header\.actions/)
  assert.match(source, /ptcPlusDescription/)
  assert.match(source, /aria-label/)
  assert.match(sourceModule, /PTC 模式的会话级 TypeScript REPL。/)
  assert.match(sourceModule, /收起 PTC Plus 设置/)
  assert.match(sourceModule, /展开 PTC Plus 设置/)
  assert.match(sourceModule, /设置会在修改后立即生效/)
  assert.doesNotMatch(sourceModule, /仅 enabled 即时生效/)
  assert.doesNotMatch(sourceModule, /saveSettings/)
  assert.doesNotMatch(source, /PTC 模式\+/)
  assert.equal(typeof require('esbuild').build, 'function')
})
