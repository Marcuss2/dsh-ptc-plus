import assert from 'node:assert/strict'
import test from 'node:test'
import { LONG_FAILED_CELL_TIP_CODE_UNITS, latestRecoveryTip } from '../internal/recovery-tips.js'

function view(code, status, contextStep = 0) {
  return {
    latestRun: {
      args: { code },
      journal: {
        status,
        completion: { kind: 'throw', error: { kind: 'exception', message: 'failed' } },
        diagnostics: [],
      },
    },
    contextStep,
    lastSuccessfulRunIndex: undefined,
    systemPromptSnapshots: [],
  }
}

test('long failed cells receive bounded edit guidance only after failure', () => {
  const code = 'x'.repeat(LONG_FAILED_CELL_TIP_CODE_UNITS)
  const safe = latestRecoveryTip(view(code, 'noop'), { enabled: true, cooldownMessages: 1, escalationFailures: 2 })
  assert.match(safe.name, /long-cell-failure\/1$/)
  assert.match(safe.text, /edit_run_code/)
  assert.match(safe.text, /no-execution/)

  const effectful = latestRecoveryTip(view(code, 'volatile'), { enabled: true, cooldownMessages: 1, escalationFailures: 2 })
  assert.doesNotMatch(effectful.text, /use `edit_run_code`/)
  assert.match(effectful.text, /inspect live state/)
})

test('short failures and disabled tips remain silent', () => {
  const short = view('return 1', 'noop')
  assert.equal(latestRecoveryTip(short, { enabled: true, cooldownMessages: 1, escalationFailures: 2 }), undefined)
  assert.equal(latestRecoveryTip(view('x'.repeat(LONG_FAILED_CELL_TIP_CODE_UNITS), 'noop'), {
    enabled: false, cooldownMessages: 1, escalationFailures: 2,
  }), undefined)
})
