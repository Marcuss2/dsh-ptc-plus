import assert from 'node:assert/strict'
import test from 'node:test'
import { average, median } from '../src/math/stats.js'

test('computes an average', () => {
  assert.equal(average([2, 4, 6]), 4)
})

test('returns zero for an empty average', () => {
  assert.equal(average([]), 0)
})

test('computes a median for odd and even inputs', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 2, 3]), 2.5)
})
