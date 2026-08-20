import assert from 'node:assert/strict'
import test from 'node:test'
import {
  capabilityFind,
  capabilityInspect,
  capabilityTree,
  toolCapabilityMetadata,
} from '../internal/program-bindings.js'

test('exploration is descriptive, deterministic, and budgeted', () => {
  const metadata = [{
    namespace: 'files',
    members: [
      { name: 'read', completeness: 'bounded', replay: 'recorded-value' },
      { name: 'write', completeness: 'complete', replay: 'volatile' },
    ],
  }]
  assert.deepEqual(capabilityTree(metadata), [{ namespace: 'files', members: ['read', 'write'] }])
  assert.deepEqual(capabilityFind(metadata, 'files.read'), [{
    symbol: 'files.read', completeness: 'bounded', effect: 'unknown', replay: 'recorded-value',
  }])
  assert.deepEqual(capabilityInspect(metadata, undefined, 1), {
    symbols: [{ namespace: 'files', name: 'read', completeness: 'bounded', replay: 'recorded-value' }],
    omitted: 1,
    unknown: [],
    budget: 1,
  })
})

test('rejects malformed metadata and replay classifications', () => {
  assert.throws(() => capabilityFind([], ''), /query must be a non-empty string/)
  assert.throws(() => toolCapabilityMetadata([null]), /tool schema must be an object/)
  assert.throws(
    () => toolCapabilityMetadata([{ name: 'read', parameters: { transform() {} }, output: {} }]),
    /parameters must be structured data/,
  )
  assert.throws(
    () => toolCapabilityMetadata([{ name: 'read', parameters: {}, output: {} }], { read: { replay: 'maybe' } }),
    /read\.replay is invalid/,
  )
})

test('projects live tool schemas as unknown unless an explicit annotation proves more', () => {
  const metadata = toolCapabilityMetadata([
    { name: 'write', description: 'Write a file.', parameters: { type: 'object' }, output: { type: 'object' } },
    { name: 'read', description: 'Read a page.', parameters: { type: 'object' }, output: { type: 'object' } },
    { name: 'run_code', description: 'Transport.', parameters: {}, output: {} },
  ], { read: {
    completeness: 'bounded',
    replay: 'owner-replay',
    effect: 'filesystem.read',
    sourceRef: { kind: 'runtime', path: 'tool:read' },
    revision: 'r2',
    fingerprint: 'read-f2',
  } })
  assert.deepEqual(metadata[0].members.map(member => [member.name, member.completeness]), [
    ['read', 'bounded'], ['write', 'unknown'],
  ])
  assert.equal(metadata[0].members[0].effect, 'filesystem.read')
  assert.equal(metadata[0].members[0].replay, 'owner-replay')
  assert.deepEqual(metadata[0].members[0].sourceRef, { kind: 'runtime', path: 'tool:read' })
  assert.equal(metadata[0].members[0].revision, 'r2')
  assert.equal(metadata[0].members[0].fingerprint, 'read-f2')
  assert.equal(metadata[0].members[1].authority, 'dsh-tool-dispatch')
  assert.equal(metadata[0].members[1].replay, 'unknown')
  assert.throws(
    () => toolCapabilityMetadata([{ name: 'read', parameters: {}, output: {} }], {
      read: { completeness: 'entire-ish' },
    }),
    /read\.completeness is invalid/,
  )
})

test('preserves every replay classification through find and inspect', () => {
  const replay = ['recorded-value', 'owner-replay', 'volatile', 'unknown']
  const metadata = [{
    namespace: 'tools',
    members: replay.map((value, index) => ({ name: `call${index}`, replay: value })),
  }]
  assert.deepEqual(
    capabilityFind(metadata, 'call').map(member => member.replay),
    replay,
  )
  assert.deepEqual(
    capabilityInspect(metadata).symbols.map(member => member.replay),
    replay,
  )
})
