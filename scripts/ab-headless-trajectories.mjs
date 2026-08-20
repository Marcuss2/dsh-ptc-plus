import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { parseDocument } from 'yaml'
import { normalizeJournal } from '../internal/session-journal.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultTasksFile = join(repoRoot, 'scripts', 'ab-trajectory-tasks.json')
const pluginMarker = '## PTC Plus program capabilities'
const runtimeSnapshotSource = 'plugin:@deepseek-ai/dsh-system-prompt:snapshot'
const neutralPersona = 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.'
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function positiveInteger(value, label, fallback) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`)
  return parsed
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

function removeTree(path) {
  return rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
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
    const startedAt = Date.now()
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
      resolveProcess({ code: code ?? 1, stdout, stderr, timedOut, durationMs: Date.now() - startedAt })
    })
  })
}

export function parseConfigDump(text, label = 'DSH config dump') {
  const document = parseDocument(text, { customTags: [jsYamlTag] })
  if (document.errors.length > 0) {
    throw new Error(`${label} is invalid YAML: ${document.errors.map(error => error.message).join('; ')}`)
  }
  if (document.warnings.length > 0) {
    throw new Error(`${label} has YAML warnings: ${document.warnings.map(error => error.message).join('; ')}`)
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

function withoutTreatment(rows) {
  return structuredClone(rows).map(row => {
    if (row.id !== 'ptc-plus') return row
    const { disabled: _disabled, ...rest } = row
    return rest
  })
}

export function validateConfigPair(pluginRows, baselineRows) {
  for (const [label, rows] of [['plugin', pluginRows], ['baseline', baselineRows]]) {
    for (const id of [
      'agent-instructions', 'skill', 'skill-filesystem', 'tool-skill',
      'session-title-llm',
    ]) {
      if (configRow(rows, id, label).disabled !== true) {
        throw new Error(`${label} config does not disable ${id}`)
      }
    }
    const customIdentity = rows.find(row => row.id === 'custom-harness-identity')
    if (customIdentity !== undefined && customIdentity.disabled !== true) {
      throw new Error(`${label} config does not disable custom-harness-identity`)
    }
    for (const absent of ['agent-presets', 'agent-spine']) {
      if (rows.some(row => row.id === absent)) throw new Error(`${label} config unexpectedly contains ${absent}`)
    }
    const systemPrompt = configRow(rows, 'system-prompt', label).config
    if (systemPrompt?.includeHarnessIdentity !== false
      || systemPrompt?.includeRuntimeContext !== true
      || systemPrompt?.persona !== neutralPersona) {
      throw new Error(`${label} config does not use the neutral A/B system-prompt contract`)
    }
  }
  if (configRow(pluginRows, 'ptc-plus', 'plugin').disabled === true) {
    throw new Error('plugin config disables ptc-plus')
  }
  if (configRow(baselineRows, 'ptc-plus', 'baseline').disabled !== true) {
    throw new Error('baseline config does not disable ptc-plus')
  }
  if (!isDeepStrictEqual(withoutTreatment(pluginRows), withoutTreatment(baselineRows))) {
    throw new Error('resolved A/B configs differ outside ptc-plus.disabled')
  }
  return {
    pluginSha256: sha256(JSON.stringify(pluginRows)),
    baselineSha256: sha256(JSON.stringify(baselineRows)),
    onlyDifference: 'ptc-plus.disabled',
  }
}

async function mapConcurrent(items, limit, mapper) {
  const output = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      output[index] = await mapper(items[index], index)
    }
  }))
  return output
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
  const snapshot = new Map()
  for (const file of await filesUnder(root)) snapshot.set(file, (await stat(file)).mtimeMs)
  return snapshot
}

async function decodeLog(file) {
  if (file.endsWith('.jsonl')) return readFile(file, 'utf8')
  return execFileSync('zstd', ['-q', '-d', '-c', file], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
}

function parseEvents(text) {
  return text.split(/\r?\n/).filter(line => line.trim() !== '').map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`invalid JSONL at line ${index + 1}: ${error.message}`)
    }
  })
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

function sourceLabel(source) {
  if (source === null || typeof source !== 'object') return 'unknown'
  return [source.kind, source.plugin, source.form].filter(value => typeof value === 'string').join(':') || 'unknown'
}

function initialInjections(events, cwd) {
  return events.flatMap(event => {
    if (event.type !== 'user/message' || event.data?.source?.kind === 'user') return []
    const text = collectText(event.data?.content).join('\n')
    return [{
      seq: event.seq,
      source: sourceLabel(event.data?.source),
      chars: text.length,
      bytes: Buffer.byteLength(text),
      sha256: sha256(text),
      normalizedSha256: sha256(normalizedForWorkspace(text, cwd)),
      text,
    }]
  })
}

function normalizedForWorkspace(value, cwd) {
  if (typeof value !== 'string') return ''
  return value.replaceAll(cwd, '<WORKSPACE>').replaceAll(cwd.replaceAll('\\', '/'), '<WORKSPACE>')
}

async function copyWorkspace(source, destination) {
  await cp(source, destination, {
    recursive: true,
    filter: path => {
      const pathFromRoot = relative(source, path)
      return pathFromRoot === '' || pathFromRoot.split(/[\\/]/, 1)[0] !== 'artifacts'
    },
  })
}

function userPrompts(events) {
  return events.flatMap(event => {
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') return []
    return [collectText(event.data?.content).join('\n')]
  })
}

function paragraphs(text) {
  return text.split(/\n\s*\n/).map(value => value.replace(/\s+/g, ' ').trim()).filter(value => value.length >= 40)
}

function duplicateParagraphs(text) {
  const counts = new Map()
  for (const paragraph of paragraphs(text)) counts.set(paragraph, (counts.get(paragraph) ?? 0) + 1)
  return [...counts.entries()].filter(([, count]) => count > 1).map(([text, count]) => ({ text, count }))
}

function multisetDifference(left, right) {
  const remaining = new Map()
  for (const value of right) remaining.set(value, (remaining.get(value) ?? 0) + 1)
  const difference = []
  for (const value of left) {
    const count = remaining.get(value) ?? 0
    if (count > 0) remaining.set(value, count - 1)
    else difference.push(value)
  }
  return difference
}

function uncertaintySignals(text) {
  const patterns = [
    /可能/g, /也许/g, /似乎/g, /不确定/g, /无法确认/g, /需要[^。\n]{0,20}确认/g,
    /\bmaybe\b/gi, /\bperhaps\b/gi, /\bunclear\b/gi, /\bnot sure\b/gi, /\bcannot confirm\b/gi,
  ]
  return patterns.flatMap(pattern => [...text.matchAll(pattern)].map(match => match[0]))
}

function analyzeSession(events, expected) {
  const failures = []
  const headers = events.filter(event => event.type === 'request/header').map(event => event.data?.header)
  const header = headers[0]
  const session = events.find(event => event.type === 'session')
  const system = typeof header?.system === 'string' ? header.system : ''
  const hasPlugin = system.includes(pluginMarker)
  const injections = initialInjections(events, expected.cwd)
  const calls = new Map()
  const results = new Map()
  const assistantTexts = []
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const messageUsages = []
  const chunkUsages = []
  let modelCallCount = 0
  let turnStartedAt
  let turnEndedAt
  let finalTurn

  for (const event of events) {
    if (event.type === 'assistant/message') {
      assistantTexts.push(...collectText(event.data?.message?.content))
      if (event.data?.usage !== undefined) {
        modelCallCount += 1
        messageUsages.push(event.data.usage)
      }
      for (const key of Object.keys(usage)) {
        const value = event.data?.usage?.[key]
        if (Number.isSafeInteger(value) && value >= 0) usage[key] += value
      }
    }
    if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage') {
      chunkUsages.push(event.data.chunk.usage)
    }
    if (event.type === 'turn/start' && Number.isFinite(event.time)) turnStartedAt ??= event.time
    if (event.type === 'tool/call') {
      const data = event.data ?? {}
      let args
      try {
        args = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '{}')
      } catch {
        failures.push(`invalid arguments for tool call ${String(data.callId)}`)
      }
      if (typeof data.callId !== 'string') failures.push(`tool call at seq ${event.seq} has no call id`)
      else {
        if (calls.has(data.callId)) failures.push(`duplicate tool call id ${data.callId}`)
        calls.set(data.callId, {
          callId: data.callId,
          seq: event.seq,
          name: data.name,
          code: args?.code,
          description: args?.description,
        })
      }
    }
    if (event.type === 'tool/result') {
      const data = event.data ?? {}
      const message = data.message ?? {}
      const callId = message.source?.callId ?? data.callId
      const content = Array.isArray(message.content) ? message.content : []
      const output = collectText(content).join('\n')
      const isError = data.isError === true || data.error !== undefined || content.some(item => item?.isError === true)
      let journal
      if (data.meta?.dshPtcPlus !== undefined) {
        try {
          journal = normalizeJournal(data.meta.dshPtcPlus)
        } catch (error) {
          failures.push(`invalid PTC journal for ${String(callId)}: ${error.message}`)
        }
      }
      if (typeof callId !== 'string') failures.push(`tool result at seq ${event.seq} has no call id`)
      else {
        if (results.has(callId)) failures.push(`duplicate tool result id ${callId}`)
        results.set(callId, {
          seq: event.seq,
          isError,
          outputChars: output.length,
          output: output.length <= 20_000 ? output : `${output.slice(0, 10_000)}\n...<truncated>...\n${output.slice(-5_000)}`,
          journal,
        })
      }
    }
    if (event.type === 'turn/end') {
      finalTurn = event
      if (Number.isFinite(event.time)) turnEndedAt = event.time
    }
  }

  for (const [callId, call] of calls) {
    const result = results.get(callId)
    if (result === undefined) failures.push(`tool call ${callId} has no result`)
    else if (result.seq <= call.seq) failures.push(`tool result ${callId} precedes its call`)
  }
  for (const callId of results.keys()) if (!calls.has(callId)) failures.push(`tool result ${callId} has no call`)
  if (JSON.stringify(messageUsages) !== JSON.stringify(chunkUsages)) {
    failures.push('assistant message usage does not match usage chunks')
  }
  if (events.some(event => event.type === 'session/title-llm-request')) {
    failures.push('session-title auxiliary model call was not disabled')
  }
  const expectedPersona = neutralPersona
    .replace('{{model}}', expected.model)
    .replace('{{cwd}}', expected.cwd)
  if (!system.startsWith(expectedPersona)) failures.push('system prompt does not start with the neutral A/B persona')
  if (injections.length !== 1 || injections[0]?.source !== runtimeSnapshotSource) {
    failures.push(`unexpected initial context sources: ${injections.map(item => item.source).join(', ') || '(none)'}`)
  }
  const prompts = userPrompts(events)
  if (prompts.length !== 1 || prompts[0] !== expected.prompt) {
    failures.push('session does not contain exactly the assigned ordinary user prompt')
  }
  for (const [index, current] of headers.entries()) {
    const tools = Array.isArray(current?.tools) ? current.tools : []
    const expectedTools = expected.variant === 'plugin'
      ? ['run_code', 'edit_run_code']
      : ['run_code']
    if (JSON.stringify(tools.map(tool => tool?.name)) !== JSON.stringify(expectedTools)) {
      failures.push(`request ${index + 1} exposes an unexpected tool surface`)
    }
    if (current?.config?.provider !== expected.provider || current?.config?.model !== expected.model) {
      failures.push(`request ${index + 1} uses unexpected model route`)
    }
    if (sha256(normalizedForWorkspace(current?.system ?? '', expected.cwd))
      !== sha256(normalizedForWorkspace(system, expected.cwd))) {
      failures.push(`request ${index + 1} changed its system prompt`)
    }
  }
  if (hasPlugin !== (expected.variant === 'plugin')) failures.push(`session resolved to ${hasPlugin ? 'plugin' : 'baseline'} prompt`)
  if (session?.cwd !== expected.cwd) failures.push(`session cwd is ${String(session?.cwd)} instead of ${expected.cwd}`)
  if (finalTurn?.data?.reason?.kind !== 'completed') failures.push(`turn ended as ${finalTurn?.data?.reason?.kind ?? 'missing'}`)
  if (assistantTexts.length === 0 || (assistantTexts.at(-1) ?? '').trim() === '') failures.push('final answer is empty')
  const journals = [...results.values()].map(result => result.journal).filter(Boolean)
  const runCodeCallIds = new Set([...calls.values()].filter(call => call.name === 'run_code').map(call => call.callId))
  if (expected.variant === 'plugin' && [...runCodeCallIds].some(callId => results.get(callId)?.journal === undefined)) {
    failures.push('plugin run_code result omitted a PTC journal')
  }
  if (expected.variant === 'baseline' && journals.length > 0) failures.push('baseline unexpectedly emitted a PTC journal')
  const nativeTopLevelCalls = [...calls.values()].filter(call => call.name !== 'run_code')
  if (expected.variant === 'plugin' && nativeTopLevelCalls.length > 0) {
    failures.push(`plugin leaked ${nativeTopLevelCalls.length} non-canonical top-level tool call(s)`)
  }

  const timeline = [...calls.values()].sort((left, right) => left.seq - right.seq).map(call => {
    const result = results.get(call.callId)
    return {
      ...call,
      resultError: result?.isError,
      outputChars: result?.outputChars,
      output: result?.output,
      journalStatus: result?.journal?.status,
      diagnostics: result?.journal?.diagnostics ?? [],
      nestedCalls: result?.journal?.calls?.map(item => ({
        global: item.global,
        member: item.member,
        ok: item.ok,
        ...(item.ok ? {} : { error: item.error }),
      })) ?? [],
    }
  })
  const ptcWarnings = timeline.flatMap(item => item.diagnostics)
    .filter(diagnostic => diagnostic.severity !== 'error')
  if (ptcWarnings.length > 0) {
    failures.push(`ordinary task emitted ${ptcWarnings.length} non-error PTC diagnostic(s)`)
  }
  const source = timeline.map(item => item.code).filter(value => typeof value === 'string')
  const sourceCounts = new Map()
  for (const value of source) sourceCounts.set(value.trim(), (sourceCounts.get(value.trim()) ?? 0) + 1)
  const repeatedSourceCalls = [...sourceCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0)
  const allAssistantText = assistantTexts.join('\n')
  const finalAnswer = assistantTexts.at(-1) ?? ''
  const namespaceMentions = Object.fromEntries(['tools', 'repl', 'capabilities', 'code'].map(namespace => [
    namespace,
    source.reduce((sum, value) => sum + [...value.matchAll(new RegExp(`\\b${namespace}\\s*[.[]`, 'g'))].length, 0),
  ]))
  return {
    session: { id: session?.id, cwd: session?.cwd, createdAt: session?.createdAt },
    variant: expected.variant,
    prompt: {
      chars: system.length,
      bytes: Buffer.byteLength(system),
      lines: system.split(/\r?\n/).length,
      sha256: sha256(system),
      normalizedSha256: sha256(normalizedForWorkspace(system, expected.cwd)),
      duplicateParagraphs: duplicateParagraphs(system),
      modelTools: (header?.tools ?? []).map(tool => tool?.name),
      runCodeSchemaChars: JSON.stringify((header?.tools ?? [])[0] ?? {}).length,
      toolsSha256: sha256(normalizedForWorkspace(JSON.stringify(header?.tools ?? []), expected.cwd)),
      injections,
    },
    eventCount: events.length,
    requestCount: headers.length,
    modelCallCount,
    turnWallMs: turnStartedAt === undefined || turnEndedAt === undefined ? undefined : turnEndedAt - turnStartedAt,
    usage,
    toolCallCount: calls.size,
    toolErrorCount: [...results.values()].filter(result => result.isError).length,
    ptcWarningCount: ptcWarnings.length,
    nativeTopLevelCallCount: nativeTopLevelCalls.length,
    canonicalizedCallCount: timeline.filter(item => /^Call .+ inside the session REPL$/.test(item.description ?? '')).length,
    nestedCallCount: timeline.reduce((sum, item) => sum + item.nestedCalls.length, 0),
    nestedErrorCount: timeline.reduce((sum, item) => sum + item.nestedCalls.filter(call => !call.ok).length, 0),
    sourceChars: source.reduce((sum, value) => sum + value.length, 0),
    repeatedSourceCalls,
    resultOutputChars: [...results.values()].reduce((sum, result) => sum + result.outputChars, 0),
    assistantTextChars: allAssistantText.length,
    finalAnswerChars: finalAnswer.length,
    questionMarks: (allAssistantText.match(/[?？]/g) ?? []).length,
    uncertaintySignals: uncertaintySignals(allAssistantText),
    namespaceMentions,
    timeline,
    finalAnswer,
    failures: [...new Set(failures)],
    system,
  }
}

function delta(plugin, baseline) {
  const fields = [
    'eventCount', 'requestCount', 'modelCallCount', 'turnWallMs', 'toolCallCount', 'toolErrorCount', 'ptcWarningCount', 'nestedCallCount', 'nestedErrorCount',
    'sourceChars', 'repeatedSourceCalls', 'resultOutputChars', 'assistantTextChars', 'finalAnswerChars', 'questionMarks',
  ]
  const result = Object.fromEntries(fields.map(field => [field, plugin[field] - baseline[field]]))
  for (const field of Object.keys(plugin.usage)) result[field] = plugin.usage[field] - baseline.usage[field]
  result.promptChars = plugin.prompt.chars - baseline.prompt.chars
  result.promptBytes = plugin.prompt.bytes - baseline.prompt.bytes
  result.runCodeSchemaChars = plugin.prompt.runCodeSchemaChars - baseline.prompt.runCodeSchemaChars
  return result
}

function aggregate(sessions, variant) {
  const selected = sessions.filter(session => session.variant === variant)
  const sum = field => selected.reduce((total, session) => total + session[field], 0)
  const result = {
    sessions: selected.length,
    inputTokens: selected.reduce((total, session) => total + session.usage.inputTokens, 0),
    cacheReadTokens: selected.reduce((total, session) => total + session.usage.cacheReadTokens, 0),
    cacheWriteTokens: selected.reduce((total, session) => total + session.usage.cacheWriteTokens, 0),
    outputTokens: selected.reduce((total, session) => total + session.usage.outputTokens, 0),
    toolCalls: sum('toolCallCount'),
    toolErrors: sum('toolErrorCount'),
    ptcWarnings: sum('ptcWarningCount'),
    nestedCallsObserved: sum('nestedCallCount'),
    nestedErrorsObserved: sum('nestedErrorCount'),
    sourceChars: sum('sourceChars'),
    resultOutputChars: sum('resultOutputChars'),
    assistantTextChars: sum('assistantTextChars'),
    uncertaintySignals: selected.reduce((total, session) => total + session.uncertaintySignals.length, 0),
    failures: selected.reduce((total, session) => total + session.failures.length, 0),
    taskPasses: selected.filter(session => session.taskValidation?.status === 'pass').length,
    taskFailures: selected.filter(session => session.taskValidation?.status === 'fail').length,
    taskUnscored: selected.filter(session => session.taskValidation?.status === 'unscored').length,
  }
  result.totalTraffic = result.inputTokens + result.cacheReadTokens + result.cacheWriteTokens + result.outputTokens
  return result
}

function metricRow(pair) {
  const p = pair.plugin
  const b = pair.baseline
  return `| ${pair.taskId} / ${pair.replicate} | ${p.modelCallCount}/${b.modelCallCount} | ${p.toolCallCount}/${b.toolCallCount} | ${p.ptcWarningCount}/${b.ptcWarningCount} | ${p.usage.inputTokens}/${b.usage.inputTokens} | ${p.usage.cacheReadTokens}/${b.usage.cacheReadTokens} | ${p.usage.outputTokens}/${b.usage.outputTokens} | ${p.sourceChars}/${b.sourceChars} | ${p.resultOutputChars}/${b.resultOutputChars} | ${p.turnWallMs}/${b.turnWallMs} | ${p.failures.length}/${b.failures.length} |`
}

function reportMarkdown(report) {
  return [
    '# PTC Plus ordinary-task A/B trajectories',
    '',
    `- model: ${report.runtime.provider}/${report.runtime.model}`,
    `- DSH: ${report.runtime.dshVersion}`,
    `- permission: ${report.runtime.permissionMode}`,
    `- replicates: ${report.runtime.replicates}`,
    `- tasks: ${report.tasks.length}`,
    `- sessions: ${report.sessions.length}`,
    '',
    '## Prompt Delta',
    '',
    `- plugin: ${report.promptComparison.pluginChars} chars`,
    `- baseline: ${report.promptComparison.baselineChars} chars`,
    `- delta: ${report.promptComparison.deltaChars} chars`,
    `- plugin-only paragraphs: ${report.promptComparison.pluginOnlyParagraphs.length}`,
    `- baseline-only paragraphs: ${report.promptComparison.baselineOnlyParagraphs.length}`,
    `- duplicate long paragraphs: plugin ${report.promptComparison.pluginDuplicateParagraphs.length}, baseline ${report.promptComparison.baselineDuplicateParagraphs.length}`,
    '',
    '## Aggregate',
    '',
    '| Variant | Sessions | Input | Cache read | Cache write | Output | Total traffic | Calls | Top-level errors | PTC warnings | Source chars | Result chars | Assistant chars | Task pass/fail/unscored | Infrastructure failures |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...['plugin', 'baseline'].map(variant => {
      const value = report.aggregate[variant]
      return `| ${variant} | ${value.sessions} | ${value.inputTokens} | ${value.cacheReadTokens} | ${value.cacheWriteTokens} | ${value.outputTokens} | ${value.totalTraffic} | ${value.toolCalls} | ${value.toolErrors} | ${value.ptcWarnings} | ${value.sourceChars} | ${value.resultOutputChars} | ${value.assistantTextChars} | ${value.taskPasses}/${value.taskFailures}/${value.taskUnscored} | ${value.failures} |`
    }),
    '',
    '## Pairs',
    '',
    '| Task / replicate | Model calls P/B | Tool calls P/B | PTC warnings P/B | Input P/B | Cache read P/B | Output P/B | Source chars P/B | Result chars P/B | Turn ms P/B | Failures P/B |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.pairs.map(metricRow),
    '',
    'Full prompts, raw sessions, trajectories, final answers, deterministic metrics, and the blinded review map are stored beside this report.',
    '',
  ].join('\n')
}

async function loadTasks(path) {
  const tasks = JSON.parse(await readFile(path, 'utf8'))
  if (!Array.isArray(tasks) || tasks.length < 2) throw new Error('A/B trajectory tasks must contain at least two tasks')
  const ids = new Set()
  for (const task of tasks) {
    if (task === null || typeof task !== 'object' || Array.isArray(task)
      || typeof task.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(task.id)
      || typeof task.prompt !== 'string' || task.prompt.trim() === ''
      || !['blind', 'test-gate', 'git-status', 'package-engine', 'readme-phrase', 'package-script']
        .includes(task.validator)) {
      throw new Error('invalid A/B trajectory task')
    }
    if (ids.has(task.id)) throw new Error(`duplicate A/B task ${task.id}`)
    ids.add(task.id)
  }
  return tasks
}

async function taskOracle(task, workspace) {
  if (task.validator === 'git-status') {
    const result = await runProcess('git', ['status', '--porcelain=v1'], { cwd: workspace, timeoutMs: 30_000 })
    if (result.code !== 0) throw new Error(`cannot establish git-status oracle for ${task.id}`)
    return result.stdout.split(/\r?\n/).filter(Boolean).map(line => line.slice(3).replace(/^.* -> /, '')).sort()
  }
  if (task.validator === 'package-engine') {
    return JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')).engines?.node
  }
  if (task.validator === 'readme-phrase') {
    return (await readFile(join(workspace, 'README.md'), 'utf8')).includes(task.phrase)
  }
  if (task.validator === 'test-gate') {
    const npmCli = process.env.npm_execpath
    if (typeof npmCli !== 'string' || npmCli.length === 0) {
      throw new Error('cannot establish test-gate oracle without npm_execpath')
    }
    const result = await runProcess(process.execPath, [npmCli, 'run', 'check'], {
      cwd: workspace,
      timeoutMs: 10 * 60_000,
    })
    return { command: 'npm run check', exitCode: result.code }
  }
  if (task.validator === 'package-script') return { name: task.script, value: task.value }
  return undefined
}

async function validateTask(task, oracle, analysis, workspace) {
  const answer = analysis.finalAnswer ?? ''
  if (task.validator === 'blind') return { status: 'unscored', reason: 'requires blind semantic review' }
  if (task.validator === 'git-status') {
    const missing = oracle.filter(path => !answer.includes(path))
    return { status: missing.length === 0 ? 'pass' : 'fail', missing }
  }
  if (task.validator === 'package-engine') {
    const expected = String(oracle)
    return { status: answer.includes(expected) || answer.includes(expected.replace(/^>=/, '')) ? 'pass' : 'fail', expected }
  }
  if (task.validator === 'readme-phrase') {
    const saysAbsent = /没有|未提到|未找到|does not|not mention/i.test(answer)
    const saysPresent = /提到|包含|mentions?|present/i.test(answer) && !saysAbsent
    const pass = oracle ? saysPresent : saysAbsent
    return { status: pass ? 'pass' : 'fail', expectedPresent: oracle }
  }
  if (task.validator === 'test-gate') {
    const ranGate = (analysis.timeline ?? []).some(item => typeof item.code === 'string'
      && /npm(?:\.cmd)?\s+run\s+check/.test(item.code) && item.resultError !== true)
    const reportsPass = oracle.exitCode === 0
      ? /通过|全部.*pass|passes|exit code\D*0|退出码\D*0/i.test(answer)
      : /失败|fail|non-?zero|非零/i.test(answer)
    return { status: ranGate && reportsPass ? 'pass' : 'fail', ranGate, oracleExitCode: oracle.exitCode }
  }
  const packageJson = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'))
  const changed = packageJson.scripts?.[oracle.name] === oracle.value
  return { status: changed ? 'pass' : 'fail', expected: oracle }
}

export async function main(env = process.env) {
  const runId = `${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`
  const artifactRoot = join(repoRoot, 'artifacts', 'ab-trajectories', runId)
  await mkdir(artifactRoot, { recursive: true })
  const runtime = {
    provider: env.DSH_PTC_AB_PROVIDER || 'opencode-go',
    model: env.DSH_PTC_AB_MODEL || 'deepseek-v4-flash',
    apiKeyEnv: env.DSH_PTC_AB_API_KEY_ENV || 'OPENCODE_GO_API_KEY',
    profile: env.DSH_PTC_AB_PROFILE || 'headless',
    permissionMode: env.DSH_PTC_AB_PERMISSION_MODE || 'danger-full-access',
    replicates: positiveInteger(env.DSH_PTC_AB_REPLICATES, 'DSH_PTC_AB_REPLICATES', 2),
    concurrency: positiveInteger(env.DSH_PTC_AB_CONCURRENCY, 'DSH_PTC_AB_CONCURRENCY', 4),
    wallMs: positiveInteger(env.DSH_PTC_AB_WALL_MS, 'DSH_PTC_AB_WALL_MS', 10 * 60 * 1000),
    cwd: windowsPath(repoRoot),
    dshVersion: execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', 'dsh --version'], { encoding: 'utf8' }).trim(),
  }
  const tasksFile = resolve(repoRoot, env.DSH_PTC_AB_TASKS_FILE || defaultTasksFile)
  const tasks = await loadTasks(tasksFile)
  const scratchRoot = join(resolve(repoRoot, '..'), '.dsh-ptc-plus-ab', runId)
  const frozenWorkspace = join(scratchRoot, 'workspace')
  await mkdir(scratchRoot, { recursive: true })
  await copyWorkspace(repoRoot, frozenWorkspace)
  const overlays = {
    plugin: join(artifactRoot, 'plugin.patch.yml'),
    baseline: join(artifactRoot, 'baseline.patch.yml'),
  }
  const install = await runProcess('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', windowsPath(join(repoRoot, 'scripts', 'install-dev.ps1')), runtime.profile,
  ], { env: { ...env, DSH_DEV_INSTALL_NO_PAUSE: '1' }, timeoutMs: runtime.wallMs })
  await writeFile(join(artifactRoot, 'install.stdout.log'), install.stdout)
  await writeFile(join(artifactRoot, 'install.stderr.log'), install.stderr)
  if (install.code !== 0) throw new Error(`plugin installation failed; see ${relative(repoRoot, artifactRoot)}`)

  const baseDump = await runProcess('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-Command',
    `& dsh --profile '${powershellPath(runtime.profile)}' --dump-config`,
  ], { env, timeoutMs: runtime.wallMs })
  await writeFile(join(artifactRoot, 'base-config.stdout.yml'), baseDump.stdout)
  await writeFile(join(artifactRoot, 'base-config.stderr.log'), baseDump.stderr)
  if (baseDump.code !== 0 || baseDump.stderr.trim() !== '') {
    throw new Error(`base DSH config preflight failed; see ${relative(repoRoot, artifactRoot)}`)
  }
  const baseRows = parseConfigDump(baseDump.stdout, 'base DSH config')
  const commonPatch = [
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
  ]
  await writeFile(overlays.plugin, [...commonPatch, ''].join('\n'))
  await writeFile(overlays.baseline, [...commonPatch, '- id: ptc-plus', '  disabled: true', ''].join('\n'))
  const resolvedConfigs = {}
  for (const variant of ['plugin', 'baseline']) {
    const dump = await runProcess('pwsh.exe', [
      '-NoLogo', '-NoProfile', '-Command',
      `& dsh --profile '${powershellPath(runtime.profile)}' --patch '${powershellPath(windowsPath(overlays[variant]))}' --dump-config`,
    ], { env, timeoutMs: runtime.wallMs })
    await writeFile(join(artifactRoot, `${variant}-config.stdout.yml`), dump.stdout)
    await writeFile(join(artifactRoot, `${variant}-config.stderr.log`), dump.stderr)
    if (dump.code !== 0 || dump.stderr.trim() !== '') {
      throw new Error(`${variant} DSH config preflight failed; see ${relative(repoRoot, artifactRoot)}`)
    }
    resolvedConfigs[variant] = parseConfigDump(dump.stdout, `${variant} DSH config`)
  }
  const configPreflight = validateConfigPair(resolvedConfigs.plugin, resolvedConfigs.baseline)
  await writeFile(join(artifactRoot, 'manifest.json'), JSON.stringify({
    runtime, tasks, configPreflight,
  }, null, 2) + '\n')
  if (env.DSH_PTC_AB_CONFIG_ONLY === '1') {
    await removeTree(scratchRoot)
    console.log(`A/B config preflight completed; artifacts: ${relative(repoRoot, artifactRoot)}`)
    return
  }
  const oracles = new Map()
  for (const task of tasks) oracles.set(task.id, await taskOracle(task, frozenWorkspace))

  const dshHomeWindows = resolveWindowsDshHome()
  const sessionsRoot = join(/^[a-zA-Z]:[\\/]/.test(repoRoot) ? dshHomeWindows : wslPath(dshHomeWindows), 'sessions')
  const sessions = []
  const processes = []
  const runEnv = { ...env, DSH_TOOLS_MODE: 'code', DSH_PERMISSION_MODE: runtime.permissionMode }
  const runArm = async (task, replicate, variant, phase) => {
    const directory = join(artifactRoot, `${task.id}-r${replicate}-${variant}`)
    const workspace = join(directory, 'workspace')
    await mkdir(directory, { recursive: true })
    await copyWorkspace(frozenWorkspace, workspace)
    const cwd = windowsPath(workspace)
    const before = await snapshotLogs(sessionsRoot)
    const startedAt = Date.now()
    let process
    try {
      process = await runProcess('pwsh.exe', [
        '-NoLogo', '-NoProfile', '-Command',
        `& dsh --profile '${powershellPath(runtime.profile)}' --patch '${powershellPath(windowsPath(overlays[variant]))}' '${powershellPath(task.prompt)}'`,
      ], { cwd: workspace, env: runEnv, timeoutMs: runtime.wallMs })
    } catch (error) {
      process = { code: 1, stdout: '', stderr: '', timedOut: false, durationMs: 0, infrastructureError: error.message }
    }
    await writeFile(join(directory, 'dsh.stdout.log'), process.stdout)
    await writeFile(join(directory, 'dsh.stderr.log'), process.stderr)
    const after = await snapshotLogs(sessionsRoot)
    const candidates = []
    for (const [file, mtime] of after) {
      if (!before.has(file) || mtime > Math.max(startedAt - 1000, before.get(file) ?? 0)) candidates.push(file)
    }
    const decoded = await Promise.all(candidates.map(async file => {
      try {
        const text = await decodeLog(file)
        return { file, text, events: parseEvents(text) }
      } catch (error) {
        return { file, error: error.message }
      }
    }))
    const matches = decoded.filter(candidate => {
      if (candidate.events === undefined || !userPrompts(candidate.events).includes(task.prompt)) return false
      const system = candidate.events.find(event => event.type === 'request/header')?.data?.header?.system ?? ''
      const sessionCwd = candidate.events.find(event => event.type === 'session')?.data?.cwd
        ?? candidate.events.find(event => event.type === 'session')?.cwd
      return system.includes(pluginMarker) === (variant === 'plugin') && sessionCwd === cwd
    })
    let analysis
    if (matches.length !== 1) {
      analysis = {
        variant,
        failures: [`found ${matches.length} matching session logs`],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        timeline: [],
        prompt: { injections: [] },
        finalAnswer: '',
      }
    } else {
      const match = matches[0]
      await writeFile(join(directory, 'session.jsonl'), match.text)
      analysis = analyzeSession(match.events, { ...runtime, cwd, variant, prompt: task.prompt })
      await writeFile(join(directory, 'system.txt'), analysis.system)
      delete analysis.system
    }
    if (process.code !== 0) analysis.failures.push(`DSH process exited with ${process.code}`)
    if (process.timedOut) analysis.failures.push(`DSH process exceeded ${runtime.wallMs}ms`)
    if (process.infrastructureError !== undefined) analysis.failures.push(process.infrastructureError)
    analysis.failures = [...new Set(analysis.failures)]
    analysis.taskValidation = await validateTask(task, oracles.get(task.id), analysis, workspace)
    analysis.workspaceStatus = (await runProcess('git', ['status', '--porcelain=v1'], {
      cwd: workspace,
      timeoutMs: 30_000,
    })).stdout
    await writeFile(join(directory, 'analysis.json'), JSON.stringify(analysis, null, 2) + '\n')
    const session = { taskId: task.id, prompt: task.prompt, replicate, variant, directory, ...analysis }
    sessions.push(session)
    processes.push({ taskId: task.id, replicate, variant, phase, ...process })
    await removeTree(workspace)
    return session
  }
  const pairSpecs = tasks.flatMap(task => Array.from(
    { length: runtime.replicates },
    (_unused, index) => ({ task, replicate: index + 1 }),
  ))
  const runPair = async ({ task, replicate }) => {
    const pluginFirst = Number.parseInt(sha256(`${runId}:${task.id}:${replicate}:order`).slice(0, 2), 16) % 2 === 0
    const order = pluginFirst ? ['plugin', 'baseline'] : ['baseline', 'plugin']
    const result = {}
    for (let phase = 0; phase < order.length; phase += 1) {
      const variant = order[phase]
      result[variant] = await runArm(task, replicate, variant, phase + 1)
    }
    return { task, replicate, ...result }
  }
  const firstPair = await runPair(pairSpecs[0])
  const firstInjectionSignature = variant => JSON.stringify(firstPair[variant].prompt.injections.map(item => ({
    source: item.source,
    chars: item.chars,
    normalizedSha256: item.normalizedSha256,
  })))
  const firstPairFailures = [
    ...firstPair.plugin.failures,
    ...firstPair.baseline.failures,
    ...(firstInjectionSignature('plugin') === firstInjectionSignature('baseline')
      ? []
      : ['initial injections differ across the preflight pair']),
  ]
  await writeFile(join(artifactRoot, 'first-pair-preflight.json'), JSON.stringify({
    taskId: firstPair.task.id,
    replicate: firstPair.replicate,
    failures: firstPairFailures,
    pluginInjections: firstPair.plugin.prompt.injections,
    baselineInjections: firstPair.baseline.prompt.injections,
  }, null, 2) + '\n')
  if (firstPairFailures.length > 0) {
    throw new Error(`first A/B pair failed model-visible context preflight; see ${relative(repoRoot, artifactRoot)}`)
  }
  await mapConcurrent(pairSpecs.slice(1), runtime.concurrency, runPair)

  const pairs = []
  const blindMap = []
  for (const task of tasks) {
    for (let replicate = 1; replicate <= runtime.replicates; replicate += 1) {
      const plugin = sessions.find(item => item.taskId === task.id && item.replicate === replicate && item.variant === 'plugin')
      const baseline = sessions.find(item => item.taskId === task.id && item.replicate === replicate && item.variant === 'baseline')
      const process = Object.fromEntries(['plugin', 'baseline'].map(variant => [
        variant,
        processes.find(item => item.taskId === task.id && item.replicate === replicate && item.variant === variant),
      ]))
      pairs.push({ taskId: task.id, prompt: task.prompt, replicate, plugin, baseline, process, delta: delta(plugin, baseline) })
      const flip = Number.parseInt(sha256(`${runId}:${task.id}:${replicate}`).slice(0, 2), 16) % 2 === 0
      const arms = flip ? [plugin, baseline] : [baseline, plugin]
      for (let index = 0; index < arms.length; index += 1) {
        const label = `${task.id}-r${replicate}-arm-${index + 1}`
        const arm = arms[index]
        const packet = {
          label,
          task: task.prompt,
          timeline: arm.timeline.map(item => ({
            description: item.description,
            code: item.code,
            resultError: item.resultError,
            outputChars: item.outputChars,
            output: item.output,
          })),
          finalAnswer: arm.finalAnswer,
          observable: {
            toolCalls: arm.toolCallCount,
            sourceChars: arm.sourceChars,
            resultOutputChars: arm.resultOutputChars,
            assistantTextChars: arm.assistantTextChars,
          },
        }
        await writeFile(join(artifactRoot, `${label}.json`), JSON.stringify(packet, null, 2) + '\n')
        blindMap.push({ label, taskId: task.id, replicate, variant: arm.variant })
      }
    }
  }
  const contextPairingFailures = []
  for (const variant of ['plugin', 'baseline']) {
    const hashes = new Set(sessions.filter(session => session.variant === variant)
      .map(session => session.prompt.normalizedSha256))
    if (hashes.size !== 1) contextPairingFailures.push(`${variant} system prompt varied across sessions`)
  }
  for (const pair of pairs) {
    const injectionSignature = session => JSON.stringify(session.prompt.injections.map(item => ({
      source: item.source,
      chars: item.chars,
      normalizedSha256: item.normalizedSha256,
    })))
    if (injectionSignature(pair.plugin) !== injectionSignature(pair.baseline)) {
      contextPairingFailures.push(`${pair.taskId}/r${pair.replicate}: initial injections differ across arms`)
    }
  }
  const exemplar = pairs[0]
  const pluginSystem = normalizedForWorkspace(
    exemplar.plugin.system ?? await readFile(join(exemplar.plugin.directory, 'system.txt'), 'utf8'),
    exemplar.plugin.session.cwd,
  )
  const baselineSystem = normalizedForWorkspace(
    exemplar.baseline.system ?? await readFile(join(exemplar.baseline.directory, 'system.txt'), 'utf8'),
    exemplar.baseline.session.cwd,
  )
  const pluginParagraphs = paragraphs(pluginSystem)
  const baselineParagraphs = paragraphs(baselineSystem)
  const promptComparison = {
    pluginChars: exemplar.plugin.prompt.chars,
    baselineChars: exemplar.baseline.prompt.chars,
    deltaChars: exemplar.plugin.prompt.chars - exemplar.baseline.prompt.chars,
    pluginOnlyParagraphs: multisetDifference(pluginParagraphs, baselineParagraphs),
    baselineOnlyParagraphs: multisetDifference(baselineParagraphs, pluginParagraphs),
    pluginDuplicateParagraphs: exemplar.plugin.prompt.duplicateParagraphs,
    baselineDuplicateParagraphs: exemplar.baseline.prompt.duplicateParagraphs,
    sharedInitialInjections: exemplar.plugin.prompt.injections,
  }
  const report = {
    runtime,
    tasks,
    promptComparison,
    contextPairingFailures,
    aggregate: { plugin: aggregate(sessions, 'plugin'), baseline: aggregate(sessions, 'baseline') },
    sessions: sessions.map(({ directory, ...session }) => ({ ...session, directory: relative(artifactRoot, directory) })),
    pairs: pairs.map(pair => ({
      taskId: pair.taskId,
      prompt: pair.prompt,
      replicate: pair.replicate,
      process: pair.process,
      delta: pair.delta,
      plugin: pair.plugin,
      baseline: pair.baseline,
    })),
    infrastructureFailures: sessions.flatMap(session => session.failures.map(failure => `${session.taskId}/r${session.replicate}/${session.variant}: ${failure}`)),
    taskFailures: sessions.filter(session => session.taskValidation?.status === 'fail')
      .map(session => `${session.taskId}/r${session.replicate}/${session.variant}`),
  }
  report.infrastructureFailures.push(...contextPairingFailures)
  await writeFile(join(artifactRoot, 'blind-map.json'), JSON.stringify(blindMap, null, 2) + '\n')
  await writeFile(join(artifactRoot, 'blind-review-rubric.md'), [
    '# Blind trajectory review',
    '',
    'Review only the `*-arm-*.json` packets. Do not inspect system prompts, raw sessions, analyses, report files, or `blind-map.json` before submitting scores.',
    '',
    'For every packet, score each dimension from 0 to 3 and cite concrete trajectory evidence:',
    '',
    '- correctness/evidence: 0 incorrect, 1 major gaps, 2 substantially correct, 3 correct and well-supported;',
    '- efficiency: 0 severe waste, 1 material avoidable work, 2 minor waste, 3 direct and proportionate;',
    '- clarity/confidence: 0 confused or unjustifiably blocked, 1 materially hesitant, 2 minor unnecessary caution, 3 clear with evidence-calibrated confidence.',
    '',
    'Do not reward or penalize a packet for using one or multiple calls by itself. Flag repeated reads, repeated source, unnecessary retries, unsupported claims, unnecessary user questions, and excessive output separately.',
    '',
  ].join('\n'))
  await writeFile(join(artifactRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(join(artifactRoot, 'report.md'), reportMarkdown(report))
  await removeTree(scratchRoot)
  if (report.infrastructureFailures.length > 0 || report.taskFailures.length > 0) {
    console.error(`A/B trajectories completed with failures; see ${relative(repoRoot, artifactRoot)}/report.md`)
    process.exitCode = 1
  } else {
    console.log(`A/B trajectories completed; artifacts: ${relative(repoRoot, artifactRoot)}`)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => {
    console.error(error.stack ?? error.message)
    process.exitCode = 1
  })
}
