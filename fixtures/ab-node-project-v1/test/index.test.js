import assert from 'node:assert/strict'
import test from 'node:test'
import { projectName } from '../src/index.js'

test('returns the fixture project name', () => {
  assert.equal(projectName(), 'ab-node-project-v1')
})
