import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeWorkerEnvironment } from '../internal/worker-client.js'

test('normalizes Windows worker environment keys without losing host values', () => {
  const normalized = normalizeWorkerEnvironment({
    Path: 'fallback-path',
    PATH: 'canonical-path',
    SYSTEMROOT: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    MixedCaseApplicationValue: 'kept',
    NODE_test_CONTEXT: 'host-only',
    node_v8_coverage: 'host-only',
  }, 'win32')
  assert.deepEqual(normalized, {
    PATH: 'canonical-path',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    MixedCaseApplicationValue: 'kept',
  })
})

test('preserves POSIX case-sensitive keys while removing host instrumentation', () => {
  assert.deepEqual(normalizeWorkerEnvironment({
    PATH: '/bin',
    Path: 'application-value',
    NODE_TEST_CONTEXT: 'host-only',
    absent: undefined,
  }, 'linux'), {
    PATH: '/bin',
    Path: 'application-value',
  })
})
