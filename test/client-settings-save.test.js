import assert from 'node:assert/strict'
import test from 'node:test'
import { saveSettings } from '../src/settings-save.js'

const fields = [{ key: 'enabled' }, { key: 'limit' }]

function scope(initial, settle) {
  let snapshot = { status: 'ready', writable: true, revision: 1, value: { ...initial } }
  const writes = []
  return {
    writes,
    getSnapshot: () => snapshot,
    async set(key, value) {
      writes.push([key, value])
      const next = settle?.(key, value, snapshot, writes.length)
      if (next instanceof Error) throw next
      if (next !== undefined) snapshot = next
      else snapshot = { ...snapshot, revision: snapshot.revision + 1, value: { ...snapshot.value, [key]: value } }
    },
  }
}

test('proves every settings write against revisioned persisted state', async () => {
  const target = scope({ enabled: true, limit: 1 })
  const before = target.getSnapshot()
  const result = await saveSettings(target, before, { enabled: false, limit: 2 }, fields)
  assert.deepEqual(result, { ok: true, persisted: ['enabled', 'limit'] })
  assert.deepEqual(target.writes, [['enabled', false], ['limit', 2]])
})

test('reports recovered refusal and stops before later fields', async () => {
  const target = scope({ enabled: true, limit: 1 }, (_key, _value, snapshot) => snapshot)
  const result = await saveSettings(
    target,
    target.getSnapshot(),
    { enabled: false, limit: 2 },
    fields,
  )
  assert.deepEqual(result, { ok: false, persisted: [], failed: 'enabled' })
  assert.deepEqual(target.writes, [['enabled', false]])
})

test('reports partial persistence and propagates thrown writes', async () => {
  const partial = scope({ enabled: true, limit: 1 }, (key, value, snapshot, count) => (
    count === 1
      ? { ...snapshot, revision: 2, value: { ...snapshot.value, [key]: value } }
      : snapshot
  ))
  assert.deepEqual(await saveSettings(
    partial, partial.getSnapshot(), { enabled: false, limit: 2 }, fields,
  ), { ok: false, persisted: ['enabled'], failed: 'limit' })

  const rejected = scope({ enabled: true, limit: 1 }, () => new Error('offline'))
  await assert.rejects(
    () => saveSettings(rejected, rejected.getSnapshot(), { enabled: false, limit: 1 }, fields),
    /offline/,
  )
})
