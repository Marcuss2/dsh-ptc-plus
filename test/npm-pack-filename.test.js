import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { extractPackFilename } from '../scripts/npm-pack-filename.mjs'

test('extracts one tarball from npm 11 and npm 12 pack reports', () => {
  const entry = { filename: 'dsh-ptc-plus-0.2.3.tgz' }

  assert.equal(extractPackFilename([entry]), entry.filename)
  assert.equal(extractPackFilename({ 'dsh-ptc-plus': entry }), entry.filename)
})

test('rejects malformed or ambiguous npm pack reports', () => {
  const validEntry = { filename: 'dsh-ptc-plus-0.2.3.tgz' }

  for (const report of [
    null,
    [],
    {},
    [{ filename: '../package.tgz' }],
    [{ filename: 'package.zip' }],
    [{}, validEntry],
    { first: validEntry, second: validEntry },
  ]) {
    assert.throws(() => extractPackFilename(report), /npm pack report/)
  }
})

test('reads a keyed npm 12 report from stdin on the active Node platform', () => {
  const scriptPath = fileURLToPath(new URL('../scripts/npm-pack-filename.mjs', import.meta.url))
  const report = JSON.stringify({
    'dsh-ptc-plus': { filename: 'dsh-ptc-plus-0.2.3.tgz' },
  })

  assert.equal(
    execFileSync(process.execPath, [scriptPath], { encoding: 'utf8', input: report }),
    'dsh-ptc-plus-0.2.3.tgz',
  )
})
