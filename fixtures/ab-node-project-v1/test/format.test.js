import assert from 'node:assert/strict'
import test from 'node:test'
import { formatCurrency, truncate } from '../src/util/format.js'

test('formats currency', () => {
  assert.equal(formatCurrency(1.5, 'USD'), 'USD 1.50')
})

test('truncates long text', () => {
  assert.equal(truncate('abcdef', 3), 'abc...')
})
