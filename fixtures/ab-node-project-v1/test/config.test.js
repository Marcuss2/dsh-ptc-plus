import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConfig } from '../internal/config.js'

test('normalizes config with defaults', () => {
  assert.deepEqual(normalizeConfig({}), {
    retries: 2,
    timeoutMs: 1000,
    locale: 'en-US',
  })
})

test('preserves valid config values', () => {
  assert.deepEqual(normalizeConfig({ retries: 5, timeoutMs: 99, locale: 'fr' }), {
    retries: 5,
    timeoutMs: 99,
    locale: 'fr',
  })
})
