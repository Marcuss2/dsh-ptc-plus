import assert from 'node:assert/strict'
import test from 'node:test'
import { synchronizeBuiltinEsmExports } from '../internal/builtin-esm-sync.js'

test('fails startup when patched builtin exports cannot be synchronized', () => {
  let calls = 0
  synchronizeBuiltinEsmExports(() => { calls += 1 })
  assert.equal(calls, 1)

  const cause = new Error('sync failed')
  assert.throws(
    () => synchronizeBuiltinEsmExports(() => { throw cause }),
    error => error.message === 'ptc-plus: failed to synchronize patched Node filesystem exports'
      && error.cause === cause,
  )
})
