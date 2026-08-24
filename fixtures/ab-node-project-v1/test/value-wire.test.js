import assert from 'node:assert/strict'
import test from 'node:test'
import { projectValueWire } from '../internal/value-wire.js'

test('marks primitives complete', () => {
  assert.deepEqual(projectValueWire('text'), { complete: true, value: 'text' })
})

test('bounds arrays and objects', () => {
  const array = projectValueWire([1, 2, 3, 4])
  assert.equal(array.complete, false)
  assert.equal(array.truncated, true)

  const object = projectValueWire({ a: 1, b: 2, c: 3, d: 4 })
  assert.equal(object.complete, false)
  assert.equal(object.truncated, true)
})
