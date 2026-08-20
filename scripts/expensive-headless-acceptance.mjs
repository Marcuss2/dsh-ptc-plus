import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseDocument } from 'yaml'
import { normalizeJournal } from '../internal/session-journal.js'
import { decodeValue } from '../internal/value-wire.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultScenarioFile = join(repoRoot, 'scripts', 'expensive-acceptance-scenarios.json')
const neutralPersona = 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.'
const runtimeSnapshotSource = 'plugin:@deepseek-ai/dsh-system-prompt:snapshot'
const jsYamlTag = {
  tag: 'tag:yaml.org,2002:js',
  resolve: value => ({ expression: value }),
}

function windowsPath(path) {
  if (/^[a-zA-Z]:[\\/]/.test(path)) return path.replaceAll('/', '\\')
  const match = path.match(/^\/mnt\/([a-zA-Z])\/(.*)$/)
  if (match === null) throw new Error(`cannot convert WSL path to Windows path: ${path}`)
  return `${match[1].toUpperCase()}:\\${match[2].replaceAll('/', '\\')}`
}

function wslPath(path) {
  if (path.startsWith('/')) return path
  const match = path.match(/^([a-zA-Z]):\\(.*)$/)
  if (match === null) throw new Error(`cannot convert Windows path to WSL path: ${path}`)
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`
}

function powershellPath(value) {
  return value.replaceAll("'", "''")
}

function terminateProcessTree(child) {
  if (process.platform !== 'win32') {
    child.kill()
    return
  }
  const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  killer.once('error', () => child.kill())
}

export function parseAcceptanceConfig(text, label = 'DSH config dump') {
  const document = parseDocument(text, { customTags: [jsYamlTag] })
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error(`${label} is invalid YAML`)
  }
  const rows = document.toJS()
  if (!Array.isArray(rows) || rows.some(row => row === null || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error(`${label} must be an array of plugin rows`)
  }
  const ids = rows.map(row => row.id).filter(id => typeof id === 'string')
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate plugin ids`)
  return rows
}

function configRow(rows, id, label) {
  const row = rows.find(item => item.id === id)
  if (row === undefined) throw new Error(`${label} has no ${id} row`)
  return row
}

export function validateAcceptanceConfig(rows) {
  const label = 'acceptance config'
  for (const id of ['agent-instructions', 'skill', 'skill-filesystem', 'tool-skill', 'session-title-llm']) {
    if (configRow(rows, id, label).disabled !== true) throw new Error(`${label} does not disable ${id}`)
  }
  const customIdentity = rows.find(row => row.id === 'custom-harness-identity')
  if (customIdentity !== undefined && customIdentity.disabled !== true) {
    throw new Error(`${label} does not disable custom-harness-identity`)
  }
  for (const absent of ['agent-presets', 'agent-spine']) {
    if (rows.some(row => row.id === absent)) throw new Error(`${label} unexpectedly contains ${absent}`)
  }
  const systemPrompt = configRow(rows, 'system-prompt', label).config
  if (systemPrompt?.includeHarnessIdentity !== false
    || systemPrompt?.includeRuntimeContext !== true
    || systemPrompt?.persona !== neutralPersona) {
    throw new Error(`${label} does not use the neutral system-prompt contract`)
  }
  if (configRow(rows, 'ptc-plus', label).disabled === true) {
    throw new Error(`${label} disables ptc-plus`)
  }
  return true
}

function resolveWindowsDshHome() {
  const command = [
    '$value = [Environment]::GetEnvironmentVariable(\'DSH_HOME\', \'Process\')',
    'if ([string]::IsNullOrWhiteSpace($value)) { $value = Join-Path ([Environment]::GetFolderPath(\'UserProfile\')) \'.dsh\' }',
    '[IO.Path]::GetFullPath($value)',
  ].join('; ')
  return execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', command], { encoding: 'utf8' }).trim()
}

async function runProcess(command, args, options = {}) {
  return await new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true
      terminateProcessTree(child)
    }, options.timeoutMs)
    timeout?.unref()
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', (error) => {
      if (timeout !== undefined) clearTimeout(timeout)
      reject(error)
    })
    child.once('close', code => {
      if (timeout !== undefined) clearTimeout(timeout)
      resolveProcess({ code: code ?? 1, stdout, stderr, timedOut })
    })
  })
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

async function filesUnder(root) {
  const result = []
  async function visit(directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd'))) result.push(path)
    }
  }
  await visit(root)
  return result
}

async function snapshotLogs(root) {
  const files = await filesUnder(root)
  const snapshot = new Map()
  for (const file of files) snapshot.set(file, (await stat(file)).mtimeMs)
  return snapshot
}

async function decodeLog(file) {
  if (file.endsWith('.jsonl')) return readFile(file, 'utf8')
  return execFileSync('zstd', ['-q', '-d', '-c', file], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
}

export function parseEvents(text) {
  return text.split(/\r?\n/).filter(line => line.trim() !== '').map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`invalid JSONL at line ${index + 1}: ${error.message}`)
    }
  })
}

export function valueContains(root, expected) {
  if (typeof expected !== 'string') throw new TypeError('expected value fragment must be a string')
  const pending = [root]
  const seen = new Set()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) {
      if (String(current).includes(expected)) return true
      continue
    }
    if (seen.has(current)) continue
    seen.add(current)
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) pending.push(descriptor.value)
    }
  }
  return false
}

function collectText(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'text' && typeof item === 'string') output.push(item)
      else collectText(item, output)
    }
  }
  return output
}

function sourceUserPrompts(events) {
  return events.flatMap(event => {
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') return []
    return [collectText(event.data?.content).join('\n')]
  })
}

function renderTemplate(value, variables) {
  if (typeof value !== 'string') return value
  return value.replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_, name) => {
    if (!Object.hasOwn(variables, name)) throw new Error(`unknown acceptance template variable ${name}`)
    return String(variables[name])
  })
}

function renderTree(value, variables) {
  if (Array.isArray(value)) return value.map(item => renderTree(item, variables))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTree(item, variables)]))
  }
  if (typeof value === 'string') {
    const match = value.match(/^\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}$/)
    if (match !== null) {
      if (!Object.hasOwn(variables, match[1])) throw new Error(`unknown acceptance template variable ${match[1]}`)
      return variables[match[1]]
    }
  }
  return renderTemplate(value, variables)
}

function assertScenarioDescriptor(value, ids) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('acceptance scenario must be an object')
  if (typeof value.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id)) {
    throw new Error('acceptance scenario id must be a lowercase kebab-case string')
  }
  if (ids.has(value.id)) throw new Error(`duplicate acceptance scenario id ${value.id}`)
  ids.add(value.id)
  if (typeof value.title !== 'string' || value.title.trim() === '') throw new Error(`${value.id}: title is required`)
  if (typeof value.task !== 'string' || value.task.trim() === '') throw new Error(`${value.id}: task is required`)
  if (value.expect === null || typeof value.expect !== 'object' || Array.isArray(value.expect)) {
    throw new Error(`${value.id}: expect must be an object`)
  }
}

async function prepareScenarios(scenarioFile, artifactRoot, selectedIds) {
  const descriptors = JSON.parse(await readFile(scenarioFile, 'utf8'))
  if (!Array.isArray(descriptors)) throw new Error('acceptance scenario file must contain an array')
  const ids = new Set()
  for (const descriptor of descriptors) assertScenarioDescriptor(descriptor, ids)
  const selected = selectedIds.length === 0
    ? descriptors
    : selectedIds.map((id) => {
        const found = descriptors.find(descriptor => descriptor.id === id)
        if (found === undefined) throw new Error(`unknown acceptance scenario ${id}`)
        return found
      })
  if (selected.length === 0) throw new Error('expensive acceptance requires at least one scenario per run')

  return await Promise.all(selected.map(async (descriptor) => {
    const scenarioRoot = join(artifactRoot, descriptor.id)
    await mkdir(scenarioRoot, { recursive: true })
    const nonce = randomUUID().replaceAll('-', '')
    const left = randomInt(10_000, 100_000)
    const right = randomInt(10_000, 100_000)
    const longLiteral = Array.from(
      { length: 320 }, (_, index) => `record-${String(index).padStart(3, '0')}`,
    ).join('|')
    const variables = {
      nonce,
      secret: `ptc-${nonce}`,
      binding: `probe_${nonce.slice(0, 12)}`,
      left,
      right,
      expectedSum: left + right,
      expectedProduct: left * right,
      longLiteral,
      expectedRepair: `${longLiteral.length}:${longLiteral.slice(-8)}`,
    }
    variables.expectedChild = `${variables.secret}:${variables.secret.length}`
    if (descriptor.fixture !== undefined) {
      const name = renderTemplate(descriptor.fixture.name, variables)
      if (typeof name !== 'string' || name === '' || name !== name.split(/[\\/]/).at(-1)) {
        throw new Error(`${descriptor.id}: fixture name must be one file name`)
      }
      const fixturePath = join(scenarioRoot, name)
      const content = renderTemplate(descriptor.fixture.content, variables)
      await writeFile(fixturePath, content)
      variables.fixturePath = windowsPath(fixturePath)
      variables.fixtureSha256 = createHash('sha256').update(content).digest('hex')
    }
    return {
      ...descriptor,
      root: scenarioRoot,
      task: renderTemplate(descriptor.task, variables),
      expect: renderTree(descriptor.expect, variables),
    }
  }))
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function inspectLog(events, scenario, expectedRuntime) {
  const failures = []
  const warnings = []
  const expect = scenario.expect
  const allowedDiagnosticCodes = new Set(expect.allowedDiagnosticCodes ?? [])
  const calls = new Map()
  const results = new Map()
  const assistantTexts = []
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
  let header
  let requestHeader
  let finalTurn
  const requestHeaders = []
  const contextSources = []

  for (const event of events) {
    if (event.type === 'session') header ??= event
    if (event.type === 'request/header') {
      requestHeader ??= event.data?.header
      requestHeaders.push(event.data?.header)
    }
    if (event.type === 'user/message' && event.data?.source?.kind !== 'user') {
      const source = event.data?.source
      contextSources.push([source?.kind, source?.plugin, source?.form]
        .filter(value => typeof value === 'string').join(':') || 'unknown')
    }
    if (event.type === 'turn/end') finalTurn = event
    if (event.type === 'assistant/message') {
      assistantTexts.push(...collectText(event.data?.message?.content))
      for (const name of Object.keys(usage)) {
        const value = event.data?.usage?.[name]
        if (Number.isSafeInteger(value) && value >= 0) usage[name] += value
      }
    }
    if (event.type === 'tool/call') {
      const data = event.data ?? {}
      if (typeof data.callId !== 'string') {
        failures.push(`tool call at seq ${event.seq} has no call id`)
        continue
      }
      let args
      try {
        args = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '{}')
      } catch {
        failures.push(`tool call ${data.callId} has invalid JSON arguments`)
      }
      if (calls.has(data.callId)) failures.push(`duplicate tool call id ${data.callId}`)
      calls.set(data.callId, {
        seq: event.seq,
        callId: data.callId,
        name: data.name,
        description: args?.description,
        code: args?.code,
      })
    }
    if (event.type === 'tool/result') {
      const data = event.data ?? {}
      const message = data.message ?? {}
      const content = Array.isArray(message.content) ? message.content : []
      const callId = message.source?.callId ?? data.callId
      const isError = content.some(item => item?.isError === true) || data.isError === true || data.error !== undefined
      const text = collectText(content).join('\n')
      let journal
      if (data.meta?.dshPtcPlus !== undefined) {
        try {
          journal = normalizeJournal(data.meta.dshPtcPlus)
        } catch (error) {
          failures.push(`run_code result ${String(callId ?? 'unknown')} has an invalid PTC journal: ${error.message}`)
        }
      }
      const nestedCalls = Array.isArray(journal?.calls)
        ? journal.calls.map(call => ({
            global: String(call.global),
            member: String(call.member),
            ok: call.ok === true,
            ...(call.ok === true ? { value: decodeValue(call.value) } : {}),
            ...(call.ok === false ? { error: String(call.error ?? 'unknown error') } : {}),
          }))
        : []
      const completion = journal?.completion?.kind === 'return'
        ? {
            kind: 'return',
            hasValue: journal.completion.hasValue,
            ...(journal.completion.hasValue ? { value: decodeValue(journal.completion.value) } : {}),
          }
        : journal?.completion
      if (typeof callId === 'string') {
        if (results.has(callId)) failures.push(`duplicate tool result id ${callId}`)
        results.set(callId, {
          seq: event.seq,
          callId,
          isError,
          outputChars: text.length,
          journalStatus: journal?.status,
          volatileReason: journal?.volatileReason,
          nestedCalls,
          completion,
        })
      } else {
        failures.push(`tool result at seq ${event.seq} has no call id`)
      }
      const expectedRejection = isError && journal?.status === 'noop'
        && journal.diagnostics.some(diagnostic => allowedDiagnosticCodes.has(diagnostic.code))
      if (isError && !expectedRejection) failures.push(`tool result reports error for ${String(callId ?? 'unknown call')}`)
      for (const diagnostic of journal?.diagnostics ?? []) {
        const rendered = `${diagnostic.severity}[${diagnostic.code}]: ${diagnostic.message}`
        warnings.push(rendered)
        if (diagnostic.severity === 'error' && !allowedDiagnosticCodes.has(diagnostic.code)) {
          failures.push(`blocking PTC diagnostic: ${rendered}`)
        }
      }
    }
  }

  for (const [callId] of calls) if (!results.has(callId)) failures.push(`tool call ${callId} has no matching result`)
  for (const [callId] of results) if (!calls.has(callId)) failures.push(`tool result ${callId} has no matching call`)
  for (const [callId, call] of calls) {
    const result = results.get(callId)
    if (result !== undefined && result.seq <= call.seq) failures.push(`tool result ${callId} does not follow its call`)
  }
  for (const call of calls.values()) {
    if (call.name !== 'run_code') failures.push(`model-facing call bypassed PTC: ${String(call.name)}`)
    if (typeof call.code !== 'string' || typeof call.description !== 'string') {
      failures.push(`run_code call ${call.callId} lacks code or description`)
      continue
    }
    if (call.code.length > 10_000) warnings.push(`oversized source in ${call.callId}: ${call.code.length} chars`)
  }
  for (const result of results.values()) {
    if (result.journalStatus === undefined) failures.push(`run_code result ${result.callId} has no PTC journal`)
    for (const nested of result.nestedCalls) {
      if (!nested.ok) warnings.push(`handled nested error in ${result.callId}: ${nested.global}.${nested.member}: ${nested.error}`)
    }
    if (result.outputChars > 100_000) failures.push(`capability result ${result.callId} is not curated (${result.outputChars} chars)`)
    else if (result.outputChars > 25_000) warnings.push(`large capability result ${result.callId}: ${result.outputChars} chars`)
  }

  const modelTools = Array.isArray(requestHeader?.tools) ? requestHeader.tools : []
  for (const [index, current] of requestHeaders.entries()) {
    const tools = Array.isArray(current?.tools) ? current.tools : []
    if (tools.length !== 2 || tools[0]?.name !== 'run_code' || tools[1]?.name !== 'edit_run_code') {
      failures.push(`request ${index + 1} model-visible tools are ${tools.map(tool => tool?.name).join(', ') || 'missing'} instead of run_code, edit_run_code`)
    }
    if (current?.config?.provider !== expectedRuntime.provider || current?.config?.model !== expectedRuntime.model) {
      failures.push(`request ${index + 1} model route is ${current?.config?.provider ?? 'missing'}/${current?.config?.model ?? 'missing'}`)
    }
  }
  const system = typeof requestHeader?.system === 'string' ? requestHeader.system : ''
  const expectedPersona = neutralPersona
    .replace('{{model}}', expectedRuntime.model)
    .replace('{{cwd}}', expectedRuntime.cwd)
  if (!system.startsWith(expectedPersona)) failures.push('system prompt does not start with the neutral acceptance persona')
  if (contextSources.length !== 1 || contextSources[0] !== runtimeSnapshotSource) {
    failures.push(`unexpected initial context sources: ${contextSources.join(', ') || '(none)'}`)
  }
  if (events.some(event => event.type === 'session/title-llm-request')) {
    failures.push('session-title auxiliary model call was not disabled')
  }
  if (!/declare const tools:/.test(system) || !/declare const repl:/.test(system)
    || !/declare const capabilities:/.test(system) || !/declare const code:/.test(system)) {
    failures.push('program SDK omits tools, repl, capabilities, or code')
  }

  const timeline = [...calls.values()].sort((left, right) => left.seq - right.seq).map(call => ({
    ...call,
    ...(results.get(call.callId) ?? { resultMissing: true }),
  }))
  if (timeline.length < (expect.minCells ?? 1)) failures.push(`only ${timeline.length} cells; expected at least ${expect.minCells}`)
  if (expect.maxCells !== undefined && timeline.length > expect.maxCells) {
    failures.push(`${timeline.length} cells exceed scenario maximum ${expect.maxCells}`)
  }
  const statuses = timeline.map(cell => cell.journalStatus).filter(status => status !== undefined)
  if (Array.isArray(expect.allowedJournalStatuses)) {
    for (const status of statuses) {
      if (!expect.allowedJournalStatuses.includes(status)) failures.push(`journal status ${status} is not allowed by scenario`)
    }
  }
  for (const required of expect.requiredJournalStatuses ?? []) {
    if (!statuses.includes(required)) failures.push(`scenario did not produce required journal status ${required}`)
  }
  for (const description of expect.requiredCellDescriptions ?? []) {
    if (!timeline.some(cell => cell.description === description)) {
      failures.push(`scenario did not produce a cell described as ${JSON.stringify(description)}`)
    }
  }
  const nestedCalls = timeline.flatMap(cell => cell.nestedCalls ?? [])
  for (const required of expect.requiredCalls ?? []) {
    const matching = nestedCalls.filter(call => call.ok && call.global === required.global && call.member === required.member)
    if (matching.length < (required.min ?? 1)) {
      failures.push(`only ${matching.length} successful ${required.global}.${required.member} calls; expected at least ${required.min ?? 1}`)
    }
    for (const expected of required.valueIncludes ?? []) {
      if (!matching.some(call => valueContains(call.value, expected))) {
        failures.push(`${required.global}.${required.member} recorded value omits ${JSON.stringify(expected)}`)
      }
    }
  }
  if (typeof expect.continuityBinding === 'string') {
    const escaped = escapeRegExp(expect.continuityBinding)
    const declaration = new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b`)
    const reference = new RegExp(`\\b${escaped}\\b`)
    const declarationIndex = timeline.findIndex(cell => declaration.test(cell.code ?? ''))
    const reuseIndex = timeline.findIndex((cell, index) => index > declarationIndex
      && reference.test(cell.code ?? '') && !declaration.test(cell.code ?? ''))
    if (declarationIndex < 0 || reuseIndex < 0) failures.push(`binding ${expect.continuityBinding} was not declared then reused across cells`)
    if (declarationIndex >= 0 && expect.declarationCellHasValue !== undefined
      && timeline[declarationIndex]?.completion?.hasValue !== expect.declarationCellHasValue) {
      failures.push(`binding declaration cell completion hasValue is ${String(timeline[declarationIndex]?.completion?.hasValue)} instead of ${expect.declarationCellHasValue}`)
    }
  }
  const completionValues = timeline
    .filter(cell => cell.completion?.kind === 'return' && cell.completion.hasValue)
    .map(cell => cell.completion.value)
  for (const expected of expect.completionEqualsAny ?? []) {
    if (!completionValues.some(value => Object.is(value, expected))) {
      failures.push(`decoded cell completions do not equal ${JSON.stringify(expected)}`)
    }
  }
  for (const expected of expect.completionIncludes ?? []) {
    if (!completionValues.some(value => valueContains(value, expected))) {
      failures.push(`decoded cell completion omits ${JSON.stringify(expected)}`)
    }
  }
  if (finalTurn?.data?.reason?.kind !== 'completed') {
    failures.push(`turn ended as ${finalTurn?.data?.reason?.kind ?? 'missing'}`)
  }
  if (header?.cwd !== expectedRuntime.cwd) failures.push(`session cwd is ${String(header?.cwd)} instead of ${expectedRuntime.cwd}`)
  const finalAnswer = assistantTexts.at(-1) ?? ''
  if (finalAnswer.trim() === '') failures.push('final answer is empty')
  for (const expected of expect.finalAnswerIncludes ?? []) {
    if (!finalAnswer.includes(expected)) failures.push(`final answer omits expected value ${JSON.stringify(expected)}`)
  }

  return {
    scenario: { id: scenario.id, title: scenario.title, task: scenario.task },
    session: { id: header?.id, cwd: header?.cwd, createdAt: header?.createdAt },
    model: requestHeader?.config,
    prompt: {
      chars: system.length,
      modelTools: modelTools.map(tool => tool?.name),
      hasReplSdk: /declare const repl:/.test(system),
      hasToolsSdk: /declare const tools:/.test(system),
      hasCapabilitiesSdk: /declare const capabilities:/.test(system),
      hasCodeSdk: /declare const code:/.test(system),
    },
    eventCount: events.length,
    toolCallCount: calls.size,
    toolResultCount: results.size,
    usage,
    timeline,
    finalAnswerChars: finalAnswer.length,
    diagnostics: [...new Set(warnings)],
    failures: [...new Set(failures)],
  }
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim()
}

function scenarioMarkdown(report) {
  const cells = report.timeline.flatMap((cell, index) => [
    `### Cell ${index + 1}: ${cell.description ?? 'missing description'}`,
    '',
    `- result: ${cell.isError ? 'error' : 'ok'}; journal: ${cell.journalStatus ?? 'missing'}; nested calls: ${cell.nestedCalls?.length ?? 0}; output: ${cell.outputChars ?? 0} chars`,
    '',
    '```ts',
    cell.code ?? '',
    '```',
    '',
  ])
  return [
    `# ${report.scenario.title}`,
    '',
    `- scenario: ${report.scenario.id}`,
    `- task: ${report.scenario.task}`,
    `- session: ${report.session.id ?? 'missing'}`,
    `- model: ${report.model?.provider ?? 'missing'}/${report.model?.model ?? 'missing'}`,
    `- events: ${report.eventCount}`,
    `- run_code calls/results: ${report.toolCallCount}/${report.toolResultCount}`,
    `- model tokens: input ${report.usage.inputTokens}, cache ${report.usage.cacheReadTokens}, output ${report.usage.outputTokens}`,
    `- final answer: ${report.finalAnswerChars} chars`,
    '',
    '## Prompt Audit',
    '',
    '| Check | Value |',
    '| --- | --- |',
    `| system prompt | ${report.prompt.chars} chars |`,
    `| model-visible tools | ${markdownCell(report.prompt.modelTools.join(', ') || 'missing')} |`,
    `| program SDK | tools=${report.prompt.hasToolsSdk}, repl=${report.prompt.hasReplSdk}, capabilities=${report.prompt.hasCapabilitiesSdk}, code=${report.prompt.hasCodeSdk} |`,
    '',
    '## Cells',
    '',
    ...cells,
    '## Diagnostics',
    '',
    ...(report.diagnostics.length === 0 ? ['none'] : report.diagnostics.map(item => `- ${item}`)),
    '',
    '## Failures',
    '',
    ...(report.failures.length === 0 ? ['none'] : report.failures.map(item => `- ${item}`)),
    '',
  ].join('\n')
}

function summaryMarkdown(summary) {
  return [
    '# Expensive DSH multi-scenario acceptance',
    '',
    `- model: ${summary.runtime.provider}/${summary.runtime.model}`,
    `- profile/tools mode: ${summary.runtime.profile}/${summary.runtime.toolsMode}`,
    `- permission mode: ${summary.runtime.permissionMode}`,
    `- concurrency: ${summary.runtime.concurrency}`,
    `- scenarios: ${summary.scenarios.length}`,
    `- model tokens: input ${summary.usage.inputTokens}, cache ${summary.usage.cacheReadTokens}, output ${summary.usage.outputTokens}`,
    '',
    '| Scenario | Process | Cells | Journal | Failures |',
    '| --- | ---: | ---: | --- | ---: |',
    ...summary.scenarios.map(item => `| ${item.id} | ${item.processCode} | ${item.toolCallCount} | ${markdownCell(item.statuses.join(', '))} | ${item.failures.length} |`),
    '',
    '## Failures',
    '',
    ...(summary.failures.length === 0 ? ['none'] : summary.failures.map(item => `- ${item}`)),
    '',
  ].join('\n')
}

function positiveInteger(value, label, fallback) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`)
  return parsed
}

export async function main(env = process.env) {
  const runId = `${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`
  const artifactRoot = join(repoRoot, 'artifacts', 'expensive', runId)
  await mkdir(artifactRoot, { recursive: true })
  const runtime = {
    provider: env.DSH_PTC_ACCEPTANCE_PROVIDER || 'opencode-go',
    model: env.DSH_PTC_ACCEPTANCE_MODEL || 'deepseek-v4-flash',
    apiKeyEnv: env.DSH_PTC_ACCEPTANCE_API_KEY_ENV || 'OPENCODE_GO_API_KEY',
    profile: env.DSH_PTC_ACCEPTANCE_PROFILE || 'headless',
    toolsMode: 'code',
    permissionMode: env.DSH_PTC_ACCEPTANCE_PERMISSION_MODE || 'danger-full-access',
    concurrency: positiveInteger(env.DSH_PTC_ACCEPTANCE_CONCURRENCY, 'DSH_PTC_ACCEPTANCE_CONCURRENCY', 3),
    wallMs: positiveInteger(env.DSH_PTC_ACCEPTANCE_WALL_MS, 'DSH_PTC_ACCEPTANCE_WALL_MS', 10 * 60 * 1000),
  }
  const scenarioFile = resolve(repoRoot, env.DSH_PTC_ACCEPTANCE_SCENARIO_FILE || defaultScenarioFile)
  const selectedIds = (env.DSH_PTC_ACCEPTANCE_SCENARIOS || '').split(',').map(value => value.trim()).filter(Boolean)
  const scenarios = await prepareScenarios(scenarioFile, artifactRoot, selectedIds)
  await writeFile(join(artifactRoot, 'manifest.json'), JSON.stringify({
    scenarioFile,
    selectedIds: scenarios.map(scenario => scenario.id),
    scenarios: scenarios.map(scenario => ({
      id: scenario.id,
      title: scenario.title,
      task: scenario.task,
      expect: scenario.expect,
    })),
  }, null, 2) + '\n')
  const overlay = join(artifactRoot, 'acceptance.patch.yml')

  const install = await runProcess('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', windowsPath(join(repoRoot, 'scripts', 'install-dev.ps1')), runtime.profile,
  ], {
    env: { ...env, DSH_DEV_INSTALL_NO_PAUSE: '1' },
    timeoutMs: runtime.wallMs,
  })
  await writeFile(join(artifactRoot, 'install.stdout.log'), install.stdout)
  await writeFile(join(artifactRoot, 'install.stderr.log'), install.stderr)
  if (install.code !== 0) throw new Error(`plugin installation failed; see ${relative(repoRoot, artifactRoot)}/install.*.log`)

  const baseDump = await runProcess('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-Command',
    `& dsh --profile '${powershellPath(runtime.profile)}' --dump-config`,
  ], { env, timeoutMs: runtime.wallMs })
  await writeFile(join(artifactRoot, 'base-config.stdout.yml'), baseDump.stdout)
  await writeFile(join(artifactRoot, 'base-config.stderr.log'), baseDump.stderr)
  if (baseDump.code !== 0 || baseDump.stderr.trim() !== '') {
    throw new Error(`base DSH config preflight failed; see ${relative(repoRoot, artifactRoot)}`)
  }
  const baseRows = parseAcceptanceConfig(baseDump.stdout, 'base DSH config')
  await writeFile(overlay, [
    '- id: settings',
    '  disabled: true',
    '- id: agent-instructions',
    '  disabled: true',
    '- id: tool-skill',
    '  disabled: true',
    '- id: skill-filesystem',
    '  disabled: true',
    '- id: skill',
    '  disabled: true',
    '- id: session-title-llm',
    '  disabled: true',
    ...(baseRows.some(row => row.id === 'custom-harness-identity')
      ? ['- id: custom-harness-identity', '  disabled: true']
      : []),
    '- id: system-prompt',
    '  config:',
    '    includeHarnessIdentity: false',
    '    includeRuntimeContext: true',
    `    persona: ${JSON.stringify(neutralPersona)}`,
    '- id: agent-default-model',
    '  config:',
    `    provider: ${JSON.stringify(runtime.provider)}`,
    `    model: ${JSON.stringify(runtime.model)}`,
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${JSON.stringify(runtime.provider)}:`,
    `        apiKeyEnv: ${JSON.stringify(runtime.apiKeyEnv)}`,
    '',
  ].join('\n'))
  const resolvedDump = await runProcess('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-Command',
    `& dsh --profile '${powershellPath(runtime.profile)}' --patch '${powershellPath(windowsPath(overlay))}' --dump-config`,
  ], { env, timeoutMs: runtime.wallMs })
  await writeFile(join(artifactRoot, 'acceptance-config.stdout.yml'), resolvedDump.stdout)
  await writeFile(join(artifactRoot, 'acceptance-config.stderr.log'), resolvedDump.stderr)
  if (resolvedDump.code !== 0 || resolvedDump.stderr.trim() !== '') {
    throw new Error(`acceptance DSH config preflight failed; see ${relative(repoRoot, artifactRoot)}`)
  }
  validateAcceptanceConfig(parseAcceptanceConfig(resolvedDump.stdout, 'acceptance DSH config'))
  if (env.DSH_PTC_ACCEPTANCE_CONFIG_ONLY === '1') {
    console.log(`expensive acceptance config preflight passed; artifacts: ${relative(repoRoot, artifactRoot)}`)
    return
  }

  const dshHomeWindows = resolveWindowsDshHome()
  const dshHome = /^[a-zA-Z]:[\\/]/.test(repoRoot) ? dshHomeWindows : wslPath(dshHomeWindows)
  const sessionsRoot = join(dshHome, 'sessions')
  const before = await snapshotLogs(sessionsRoot)
  const startedAt = Date.now()
  const processResults = await mapConcurrent(scenarios, runtime.concurrency, async (scenario) => {
    let result
    try {
      result = await runProcess('pwsh.exe', [
        '-NoLogo', '-NoProfile', '-Command',
        `& dsh --profile '${powershellPath(runtime.profile)}' --patch '${powershellPath(windowsPath(overlay))}' '${powershellPath(scenario.task)}'`,
      ], {
        cwd: scenario.root,
        env: { ...env, DSH_TOOLS_MODE: runtime.toolsMode, DSH_PERMISSION_MODE: runtime.permissionMode },
        timeoutMs: runtime.wallMs,
      })
    } catch (error) {
      result = { code: 1, stdout: '', stderr: '', timedOut: false, infrastructureError: error.message }
    }
    await writeFile(join(scenario.root, 'dsh.stdout.log'), result.stdout)
    await writeFile(join(scenario.root, 'dsh.stderr.log'), result.stderr)
    return result
  })

  const after = await snapshotLogs(sessionsRoot)
  const candidates = []
  for (const [file, mtime] of after) {
    if (!before.has(file) || mtime > Math.max(startedAt - 1000, before.get(file) ?? 0)) candidates.push(file)
  }
  const decoded = await Promise.all(candidates.map(async (file) => {
    try {
      const text = await decodeLog(file)
      return { file, text, events: parseEvents(text) }
    } catch (error) {
      return { file, error: error.message }
    }
  }))

  const scenarioResults = []
  const claimedLogs = new Set()
  for (let index = 0; index < scenarios.length; index++) {
    const scenario = scenarios[index]
    const processResult = processResults[index]
    const scenarioCwd = windowsPath(scenario.root)
    const matches = decoded.filter(item => item.events !== undefined
      && item.events.some(event => event.type === 'session' && event.cwd === scenarioCwd)
      && sourceUserPrompts(item.events).includes(scenario.task))
    let report
    let logFile
    if (matches.length !== 1) {
      report = {
        scenario: { id: scenario.id, title: scenario.title, task: scenario.task },
        session: {}, model: {}, prompt: {}, eventCount: 0, toolCallCount: 0, toolResultCount: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, timeline: [], finalAnswerChars: 0,
        diagnostics: [], failures: [`found ${matches.length} matching session logs; expected exactly one`],
      }
    } else {
      const match = matches[0]
      logFile = match.file
      if (claimedLogs.has(match.file)) {
        report = inspectLog(match.events, scenario, { ...runtime, cwd: scenarioCwd })
        report.failures.push(`session log was also assigned to another scenario: ${match.file}`)
      }
      else {
        claimedLogs.add(match.file)
        await writeFile(join(scenario.root, 'session.jsonl'), match.text)
        report = inspectLog(match.events, scenario, { ...runtime, cwd: scenarioCwd })
      }
    }
    if (processResult.code !== 0) report.failures.push(`DSH process exited with ${processResult.code}`)
    if (processResult.timedOut) report.failures.push(`DSH process exceeded ${runtime.wallMs}ms wall timeout`)
    if (processResult.infrastructureError !== undefined) report.failures.push(`DSH process failed to start: ${processResult.infrastructureError}`)
    report.failures = [...new Set(report.failures)]
    await writeFile(join(scenario.root, 'analysis.json'), JSON.stringify({ ...report, logFile }, null, 2) + '\n')
    await writeFile(join(scenario.root, 'analysis.md'), scenarioMarkdown(report))
    scenarioResults.push({ report, processCode: processResult.code })
  }

  const usage = scenarioResults.reduce((total, { report }) => {
    for (const name of Object.keys(total)) total[name] += report.usage[name]
    return total
  }, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })
  const summary = {
    runtime: {
      provider: runtime.provider,
      model: runtime.model,
      profile: runtime.profile,
      toolsMode: runtime.toolsMode,
      permissionMode: runtime.permissionMode,
      concurrency: runtime.concurrency,
    },
    usage,
    scenarios: scenarioResults.map(({ report, processCode }) => ({
      id: report.scenario.id,
      processCode,
      toolCallCount: report.toolCallCount,
      statuses: report.timeline.map(cell => cell.journalStatus ?? 'missing'),
      failures: report.failures,
    })),
  }
  summary.failures = summary.scenarios.flatMap(item => item.failures.map(failure => `${item.id}: ${failure}`))
  await writeFile(join(artifactRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  await writeFile(join(artifactRoot, 'summary.md'), summaryMarkdown(summary))
  if (summary.failures.length > 0) {
    console.error(`expensive acceptance failed; see ${relative(repoRoot, artifactRoot)}/summary.md`)
    process.exitCode = 1
  } else {
    console.log(`expensive acceptance passed; artifacts: ${relative(repoRoot, artifactRoot)}`)
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) {
  await main().catch((error) => {
    console.error(error.stack ?? error.message)
    process.exitCode = 1
  })
}
