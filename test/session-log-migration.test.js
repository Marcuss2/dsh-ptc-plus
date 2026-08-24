import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  main,
  migrateSessionLogFile,
  migrateSessionLogText,
} from '../scripts/migrate-session-log.mjs'

const legacyEvent = {
  seq: 1,
  type: 'ptc-plus/recovery-boundary',
  data: { failedCallSeq: 0, frontierCallSeq: null },
}

function logText(events) {
  return `${events.map(event => JSON.stringify(event)).join('\n')}\n`
}

test('migrates decoded JSONL and reports a no-op for current logs', () => {
  const source = logText([
    { seq: 0, type: 'tool/call', data: { name: 'run_code', callId: 'failed' } },
    legacyEvent,
    { seq: 2, type: 'tool/result', sourceEventSeqs: [0], data: { meta: {} } },
  ])
  const migrated = migrateSessionLogText(source)
  assert.equal(migrated.changed, true)
  assert.equal(migrated.legacyCount, 1)
  assert.equal(migrated.text.includes('ptc-plus/recovery-boundary'), false)
  assert.equal(JSON.parse(migrated.text.split('\n')[1]).seq, 1)
  assert.deepEqual(JSON.parse(migrated.text.split('\n')[1]).data.meta.dshPtcPlusRecoveryBoundaries, [{
    failedCallSeq: 0,
    frontierCallSeq: null,
  }])

  const current = migrateSessionLogText(migrated.text)
  assert.deepEqual(current, { changed: false, legacyCount: 0, text: migrated.text })
})

test('migrates a file without replacing the source or an existing destination', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ptc-log-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'session.jsonl')
  const output = join(root, 'migrated.jsonl')
  const source = logText([legacyEvent, { seq: 1, type: 'tool/result', data: {} }])
  await writeFile(input, source)
  const result = await migrateSessionLogFile(input, output)
  assert.equal(result.written, true)
  assert.equal(await readFile(input, 'utf8'), source)
  assert.equal((await readFile(output, 'utf8')).includes('ptc-plus/recovery-boundary'), false)
  await assert.rejects(() => migrateSessionLogFile(input, output), /output already exists/)
  const forced = await migrateSessionLogFile(input, output, { overwrite: true })
  assert.equal(forced.written, true)
})

test('CLI main validates required paths and leaves current logs untouched', async () => {
  await assert.rejects(() => main([]), /Usage:/)
})
