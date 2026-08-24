import assert from 'node:assert/strict'
import test from 'node:test'
import { farewell, greeting } from '../src/greeting.js'

test('greets a person', () => {
  assert.equal(greeting('Ada'), 'Hello, Ada!')
})

test('says farewell', () => {
  assert.equal(farewell('Ada'), 'Goodbye, Ada!')
})
