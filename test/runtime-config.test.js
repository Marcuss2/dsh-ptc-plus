import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_TIMER_DELAY_MS, validateMaxWallMs } from '../internal/runtime-config.js'
import { SessionRuntime } from '../internal/session-runtime.js'

test('owns the runtime wall-clock ceiling', () => {
  assert.equal(validateMaxWallMs(MAX_TIMER_DELAY_MS), MAX_TIMER_DELAY_MS)
  assert.throws(() => validateMaxWallMs(0), /positive safe integer/)
  assert.throws(() => validateMaxWallMs(MAX_TIMER_DELAY_MS + 1), /must not exceed/)

  const runtime = new SessionRuntime({ maxWallMs: MAX_TIMER_DELAY_MS })
  assert.equal(runtime.config.maxWallMs, MAX_TIMER_DELAY_MS)
  assert.throws(() => new SessionRuntime({ maxWallMs: MAX_TIMER_DELAY_MS + 1 }), /must not exceed/)
  return runtime.dispose()
})
