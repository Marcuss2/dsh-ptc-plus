import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const DSH_RUNTIME_PEERS = [
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-cordis',
  '@deepseek-ai/dsh-tools',
]

test('keeps host-owned DSH runtime packages out of plugin dependencies', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const ordinaryDshDependencies = Object.keys(manifest.dependencies ?? {})
    .filter(name => name.startsWith('@deepseek-ai/dsh-'))

  assert.deepEqual(ordinaryDshDependencies, [])
  for (const packageName of DSH_RUNTIME_PEERS) {
    assert.equal(manifest.peerDependencies?.[packageName], 'next')
    assert.equal(manifest.devDependencies?.[packageName], 'next')
  }
})
