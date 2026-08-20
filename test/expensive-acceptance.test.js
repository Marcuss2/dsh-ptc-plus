import assert from 'node:assert/strict'
import test from 'node:test'
import {
  inspectLog,
  parseAcceptanceConfig,
  parseEvents,
  validateAcceptanceConfig,
  valueContains,
} from '../scripts/expensive-headless-acceptance.mjs'
import { encodeValue } from '../internal/value-wire.js'

function journal({ calls = [], completion, diagnostics = [], status = 'durable' } = {}) {
  return {
    version: 1,
    bindingMode: 'loose',
    status,
    calls: calls.map((call, settle) => ({
      global: call.global,
      member: call.member,
      args: encodeValue(call.args ?? {}),
      ok: call.ok ?? true,
      ...((call.ok ?? true) ? { value: encodeValue(call.value) } : { error: call.error }),
      settle,
    })),
    operations: [],
    confirms: [],
    diagnostics,
    completion: completion === undefined
      ? { kind: 'return', hasValue: false }
      : { kind: 'return', hasValue: true, value: encodeValue(completion) },
  }
}

function acceptanceEvents() {
  const system = [
    'You are a coding agent powered by the model model. Your working directory is G:\\work.',
    'declare const tools: {}',
    'declare const repl: {}',
    'declare const capabilities: {}',
    'declare const code: {}',
  ].join('\n')
  return [
    { type: 'session', cwd: 'G:\\work', id: 'session-test' },
    {
      type: 'request/header',
      data: {
        header: {
          config: { provider: 'provider', model: 'model' },
          tools: [{ name: 'run_code' }, { name: 'edit_run_code' }],
          system,
        },
      },
    },
    {
      type: 'tool/call', seq: 10,
      data: { callId: 'one', name: 'run_code', arguments: JSON.stringify({ code: 'const probe_random = 20', description: 'Establish random binding' }) },
    },
    {
      type: 'tool/result', seq: 11,
      data: {
        message: { source: { callId: 'one' }, content: [{ type: 'text', text: 'ok' }] },
        meta: { dshPtcPlus: journal() },
      },
    },
    {
      type: 'tool/call', seq: 12,
      data: { callId: 'two', name: 'run_code', arguments: JSON.stringify({ code: 'return probe_random + 22', description: 'Reuse random binding' }) },
    },
    {
      type: 'tool/result', seq: 13,
      data: {
        message: { source: { callId: 'two' }, content: [{ type: 'text', text: '42' }] },
        meta: {
          dshPtcPlus: journal({
            calls: [{ global: 'tools', member: 'read', value: { lines: [{ text: 'sentinel' }] } }],
            completion: 42,
          }),
        },
      },
    },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'The result is 42.' }] }, usage: { inputTokens: 3, outputTokens: 2 } },
    },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    {
      type: 'user/message',
      data: {
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' },
        content: [{ type: 'text', text: 'runtime policy' }],
      },
    },
  ]
}

test('validates a clean expensive-acceptance profile', () => {
  const rows = parseAcceptanceConfig(`
- id: agent-instructions
  disabled: true
- id: skill
  disabled: true
- id: skill-filesystem
  disabled: true
- id: tool-skill
  disabled: true
- id: session-title-llm
  disabled: true
- id: custom-harness-identity
  disabled: true
- id: system-prompt
  config:
    includeHarnessIdentity: false
    includeRuntimeContext: true
    persona: 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.'
- id: ptc-plus
  name: dsh-ptc-plus
`)
  assert.equal(validateAcceptanceConfig(rows), true)

  const contaminated = structuredClone(rows)
  contaminated.find(row => row.id === 'agent-instructions').disabled = false
  assert.throws(() => validateAcceptanceConfig(contaminated), /does not disable agent-instructions/)
  assert.throws(() => parseAcceptanceConfig('- id: [\n'), /invalid YAML/)
})

test('parses JSONL and rejects malformed lines', () => {
  assert.deepEqual(parseEvents('{"type":"session"}\n'), [{ type: 'session' }])
  assert.throws(() => parseEvents('{nope}\n'), /invalid JSONL at line 1/)
})

test('matches unescaped primitive values inside nested and cyclic graphs', () => {
  const expected = '{[(|)]}|`|"|\\|ptc-sentinel'
  const cyclic = { nested: [0, { result: `prefix:${expected}:suffix` }] }
  cyclic.self = cyclic

  assert.equal(valueContains(cyclic, expected), true)
  assert.equal(valueContains(cyclic, '0'), true)
  assert.equal(valueContains({ [expected]: 'different' }, expected), false)
  assert.equal(valueContains(cyclic, 'missing'), false)
  assert.throws(() => valueContains(cyclic, 0), /fragment must be a string/)
})

test('audits protocol values and randomized cross-cell reuse', () => {
  const report = inspectLog(acceptanceEvents(), {
    id: 'continuity',
    title: 'Continuity',
    task: 'task',
    expect: {
      minCells: 2,
      maxCells: 3,
      allowedJournalStatuses: ['durable'],
      continuityBinding: 'probe_random',
      declarationCellHasValue: false,
      requiredCalls: [{ global: 'tools', member: 'read', valueIncludes: ['sentinel'] }],
      completionEqualsAny: [42],
      finalAnswerIncludes: ['42'],
    },
  }, { provider: 'provider', model: 'model', cwd: 'G:\\work' })

  assert.deepEqual(report.failures, [])
  assert.equal(report.timeline[1].completion.value, 42)
  assert.deepEqual(report.timeline[1].nestedCalls[0].value, { lines: [{ text: 'sentinel' }] })
})

test('records a handled nested error as a diagnostic instead of a product failure', () => {
  const events = acceptanceEvents()
  events[3].data.meta.dshPtcPlus = journal({
    calls: [{ global: 'tools', member: 'read', ok: false, error: 'not found' }],
  })
  const report = inspectLog(events, {
    id: 'handled-error', title: 'Handled error', task: 'task',
    expect: { minCells: 2, allowedJournalStatuses: ['durable'] },
  }, { provider: 'provider', model: 'model', cwd: 'G:\\work' })

  assert.deepEqual(report.failures, [])
  assert.match(report.diagnostics.join('\n'), /handled nested error.*not found/)
})

test('allows only explicitly expected pre-execution diagnostics', () => {
  const events = acceptanceEvents()
  events[3].data.message.content = [{ type: 'text', text: 'syntax rejected', isError: true }]
  events[3].data.meta.dshPtcPlus = journal({
    status: 'noop',
    diagnostics: [{
      code: 'PTC-C001', severity: 'error', phase: 'parse',
      message: 'cell syntax could not be parsed', stateEffect: 'unchanged',
      dispatchState: 'not-dispatched', help: ['repair this cell'],
    }],
  })
  const scenario = {
    id: 'expected-rejection', title: 'Expected rejection', task: 'task',
    expect: {
      minCells: 2,
      allowedJournalStatuses: ['noop', 'durable'],
      allowedDiagnosticCodes: ['PTC-C001'],
    },
  }
  const runtime = { provider: 'provider', model: 'model', cwd: 'G:\\work' }

  const allowed = inspectLog(events, scenario, runtime)
  assert.deepEqual(allowed.failures, [])
  assert.match(allowed.diagnostics.join('\n'), /error\[PTC-C001\]/)

  const denied = inspectLog(events, {
    ...scenario,
    expect: { ...scenario.expect, allowedDiagnosticCodes: [] },
  }, runtime)
  assert.match(denied.failures.join('\n'), /tool result reports error/)
  assert.match(denied.failures.join('\n'), /blocking PTC diagnostic: error\[PTC-C001\]/)
})

test('rejects continuity that returns the established binding from its declaration cell', () => {
  const events = acceptanceEvents()
  events[3].data.meta.dshPtcPlus = journal({ completion: 20 })
  const report = inspectLog(events, {
    id: 'transported-binding', title: 'Transported binding', task: 'task',
    expect: {
      minCells: 2,
      continuityBinding: 'probe_random',
      declarationCellHasValue: false,
      completionEqualsAny: [42],
    },
  }, { provider: 'provider', model: 'model', cwd: 'G:\\work' })

  assert.match(report.failures.join('\n'), /binding declaration cell completion hasValue is true instead of false/)
})
