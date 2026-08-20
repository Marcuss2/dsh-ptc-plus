import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseConfigDump,
  validateConfigPair,
} from '../scripts/ab-headless-trajectories.mjs'

const persona = 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.'

function rows(ptcDisabled, customIdentity = true) {
  return [
    { id: 'agent-instructions', disabled: true },
    { id: 'skill', disabled: true },
    { id: 'skill-filesystem', disabled: true },
    { id: 'tool-skill', disabled: true },
    { id: 'session-title-llm', disabled: true },
    {
      id: 'system-prompt',
      config: {
        includeHarnessIdentity: false,
        includeRuntimeContext: true,
        persona,
      },
    },
    { id: 'ptc-plus', name: 'dsh-ptc-plus', ...(ptcDisabled ? { disabled: true } : {}) },
    ...(customIdentity ? [{ id: 'custom-harness-identity', disabled: true }] : []),
    { id: 'sandbox', config: { mode: { expression: "process.env.DSH_PERMISSION_MODE ?? 'workspace-write'" } } },
  ]
}

test('parses commented DSH dumps and preserves unevaluated JavaScript expressions', () => {
  const parsed = parseConfigDump(`
# source layer
- id: sandbox
  disabled: !!js process.platform === 'win32'
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE
`)
  assert.deepEqual(parsed, [{
    id: 'sandbox',
    disabled: { expression: "process.platform === 'win32'" },
    config: { mode: { expression: 'process.env.DSH_PERMISSION_MODE' } },
  }])
  assert.throws(() => parseConfigDump('- id: duplicate\n- id: duplicate\n'), /duplicate plugin ids/)
  assert.throws(() => parseConfigDump('not: an array\n'), /array of plugin rows/)
  assert.throws(() => parseConfigDump('- id: [\n'), /invalid YAML/)
})

test('accepts an A/B config pair whose only treatment is ptc-plus.disabled', () => {
  const plugin = rows(false)
  const baseline = rows(true)
  const result = validateConfigPair(plugin, baseline)
  assert.equal(result.onlyDifference, 'ptc-plus.disabled')
  assert.equal(result.pluginSha256.length, 64)
  assert.equal(result.baselineSha256.length, 64)
  assert.doesNotThrow(() => validateConfigPair(rows(false, false), rows(true, false)))
})

test('rejects missing isolation, fake headless rows, and any second treatment', () => {
  const baseline = rows(true)
  const enabledInstructions = rows(false)
  enabledInstructions.find(row => row.id === 'agent-instructions').disabled = false
  assert.throws(() => validateConfigPair(enabledInstructions, baseline), /does not disable agent-instructions/)

  const fakeSpine = rows(false)
  fakeSpine.push({ id: 'agent-spine', config: { workspaceContext: false } })
  assert.throws(() => validateConfigPair(fakeSpine, baseline), /unexpectedly contains agent-spine/)

  const customIdentity = rows(false)
  customIdentity.find(row => row.id === 'custom-harness-identity').disabled = false
  assert.throws(() => validateConfigPair(customIdentity, baseline), /does not disable custom-harness-identity/)

  const wrongPersona = rows(false)
  wrongPersona.find(row => row.id === 'system-prompt').config.persona = 'task-specific prior'
  assert.throws(() => validateConfigPair(wrongPersona, baseline), /neutral A\/B system-prompt contract/)

  const secondTreatment = rows(true)
  secondTreatment.find(row => row.id === 'sandbox').config.extra = true
  assert.throws(() => validateConfigPair(rows(false), secondTreatment), /differ outside ptc-plus.disabled/)

  assert.throws(() => validateConfigPair(rows(true), baseline), /plugin config disables ptc-plus/)
  assert.throws(() => validateConfigPair(rows(false), rows(false)), /baseline config does not disable ptc-plus/)
})
