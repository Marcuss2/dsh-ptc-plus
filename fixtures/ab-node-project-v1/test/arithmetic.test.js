import assert from 'node:assert/strict'
import test from 'node:test'
import { add, isEven, multiply } from '../src/math/arithmetic.js'

test('adds numbers', () => {
  assert.equal(add(2, 3), 5)
})

test('multiplies numbers', () => {
  assert.equal(multiply(3, 4), 12)
})

test('recognizes even numbers', () => {
  assert.equal(isEven(4), true)
  assert.equal(isEven(7), false)
})
