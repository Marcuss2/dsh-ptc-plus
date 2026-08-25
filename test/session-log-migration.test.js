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

const sessionHeader = {
  type: 'session', version: 0, id: 'migration-test', createdAt: 1, cwd: 'G:\\workspace',
}

function logText(events) {
  return `${events.map(event => JSON.stringify(event)).join('\n')}\n`
}

test('migrates decoded JSONL and reports a no-op for current logs', () => {
  const source = logText([
    sessionHeader,
    { seq: 0, type: 'tool/call', data: { name: 'run_code', callId: 'failed' } },
    legacyEvent,
    { seq: 2, type: 'tool/result', sourceEventSeqs: [0], data: { meta: {} } },
  ])
  const migrated = migrateSessionLogText(source)
  assert.equal(migrated.changed, true)
  assert.equal(migrated.legacyCount, 1)
  assert.equal(migrated.text.includes('ptc-plus/recovery-boundary'), false)
  assert.deepEqual(JSON.parse(migrated.text.split('\n')[0]), sessionHeader)
  assert.equal(JSON.parse(migrated.text.split('\n')[2]).seq, 1)
  assert.deepEqual(JSON.parse(migrated.text.split('\n')[2]).data.meta.dshPtcPlusRecoveryBoundaries, [{
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
  const source = logText([
    sessionHeader,
    { ...legacyEvent, seq: 0 },
    { seq: 1, type: 'tool/result', data: {} },
  ])
  await writeFile(input, source)
  const result = await migrateSessionLogFile(input, output)
  assert.equal(result.written, true)
  assert.equal(await readFile(input, 'utf8'), source)
  assert.equal((await readFile(output, 'utf8')).includes('ptc-plus/recovery-boundary'), false)
  await assert.rejects(() => migrateSessionLogFile(input, output), /output already exists/)
  const forced = await migrateSessionLogFile(input, output, { overwrite: true })
  assert.equal(forced.written, true)
})

test('encodes the session header and events as independent Zstandard frames', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ptc-log-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'session.jsonl')
  const output = join(root, 'migrated.jsonl.zstd')
  const source = logText([
    { type: 'session', version: 0, id: 'framed', createdAt: 1, cwd: root },
    legacyEvent,
    { seq: 1, type: 'tool/result', data: {} },
  ])
  const frames = []
  const execFileSync = (command, args, options) => {
    assert.equal(command, 'zstd')
    assert.deepEqual(args, ['-q', '-T0', '--check', '-c'])
    frames.push(options.input)
    return Buffer.from(`<frame>${options.input}</frame>`)
  }
  await writeFile(input, source)

  await migrateSessionLogFile(input, output, { execFileSync })

  assert.equal(frames.length, 2)
  assert.equal(frames[0], `${JSON.stringify(JSON.parse(source.split('\n')[0]))}\n`)
  assert.equal(frames[0].split('\n').length, 2)
  assert.equal(frames[1].includes('ptc-plus/recovery-boundary'), false)
  assert.equal(frames[1].includes('dshPtcPlusRecoveryBoundaries'), true)
  assert.equal(
    await readFile(output, 'utf8'),
    frames.map(frame => `<frame>${frame}</frame>`).join(''),
  )
})

test('CLI main validates required paths and leaves current logs untouched', async () => {
  await assert.rejects(() => main([]), /Usage:/)
})
