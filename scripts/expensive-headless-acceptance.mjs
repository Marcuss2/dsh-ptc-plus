import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runId = new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')
const artifactRoot = join(repoRoot, 'artifacts', 'expensive', runId)
const task = '介绍本项目'
const agentPreset = process.env.DSH_PTC_ACCEPTANCE_PRESET ?? 'code'
if (!['code', 'omnipotent'].includes(agentPreset)) {
  throw new Error('DSH_PTC_ACCEPTANCE_PRESET must be code or omnipotent')
}
const wslRepoRoot = repoRoot
const windowsRepoRoot = windowsPath(repoRoot)

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

function resolveWindowsDshHome() {
  const command = [
    '$value = [Environment]::GetEnvironmentVariable(\'DSH_HOME\', \'Process\')',
    'if ([string]::IsNullOrWhiteSpace($value)) { $value = Join-Path ([Environment]::GetFolderPath(\'UserProfile\')) \'.dsh\' }',
    '[IO.Path]::GetFullPath($value)',
  ].join('; ')
  return execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', command], { encoding: 'utf8' }).trim()
}

async function runProcess(command, args, options = {}) {
  const stdoutPath = options.stdoutPath
  const stderrPath = options.stderrPath
  return await new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout = stdoutPath === undefined ? undefined : createWriteStream(stdoutPath)
    const stderr = stderrPath === undefined ? undefined : createWriteStream(stderrPath)
    let capturedStdout = ''
    let capturedStderr = ''
    if (stdout === undefined) child.stdout.on('data', chunk => { capturedStdout += chunk })
    else child.stdout.pipe(stdout)
    if (stderr === undefined) child.stderr.on('data', chunk => { capturedStderr += chunk })
    else child.stderr.pipe(stderr)
    child.once('error', reject)
    child.once('close', code => {
      stdout?.end()
      stderr?.end()
      resolveProcess({ code: code ?? 1, stdout: capturedStdout, stderr: capturedStderr })
    })
  })
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

function decodeLog(file) {
  if (file.endsWith('.jsonl')) return readFile(file, 'utf8')
  const output = execFileSync('zstd', ['-q', '-d', '-c', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return output
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

function promptConflicts(system) {
  const conflicts = []
  const checks = [
    [/\btools\s*\.\s*[A-Za-z_]/, 'exposes a tools.* program call'],
    [/\b(?:use|call)\s+the\s+[A-Za-z_][\w-]*\s+tool\b/i, 'instructs a native tool call'],
    [/\bgoal tools\b/i, 'describes model-callable goal tools'],
    [/\bcall\s+(?:create_goal|get_goal|update_goal)\b/i, 'instructs a direct goal-tool call'],
    [/\b(?:collect|read|stop)\b[^\n]{0,50}\b(?:with|using)\s+(?:job_output|job_kill)\b/i,
      'instructs a direct background-job tool call'],
  ]
  for (const [pattern, label] of checks) if (pattern.test(system)) conflicts.push(label)
  return conflicts
}

function inspectLog(events) {
  const failures = []
  const warnings = []
  const calls = new Map()
  const results = new Map()
  const assistantTexts = []
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
  let header
  let requestHeader
  let finalTurn

  for (const event of events) {
    if (event.type === 'session') header = event
    if (event.type === 'request/header') requestHeader = event.data?.header
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
      const callId = data.callId
      if (typeof callId !== 'string') {
        failures.push(`tool call at seq ${event.seq} has no call id`)
        continue
      }
      let args
      try {
        args = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '{}')
      } catch {
        failures.push(`tool call ${callId} has invalid JSON arguments`)
      }
      calls.set(callId, {
        seq: event.seq,
        callId,
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
      const isError = content.some(item => item?.isError === true)
        || data.isError === true
        || data.error !== undefined
      const text = collectText(content).join('\n')
      const journal = data.meta?.dshPtcPlus
      const nestedFailures = Array.isArray(journal?.calls)
        ? journal.calls.filter(call => call?.ok === false).map(call => ({
            capability: `${String(call.global)}.${String(call.member)}`,
            error: String(call.error ?? 'unknown error'),
          }))
        : []
      if (typeof callId === 'string') {
        results.set(callId, {
          seq: event.seq,
          callId,
          isError,
          outputChars: text.length,
          journalStatus: journal?.status,
          volatileReason: journal?.volatileReason,
          nestedCallCount: Array.isArray(journal?.calls) ? journal.calls.length : 0,
          nestedFailures,
        })
      } else {
        failures.push(`tool result at seq ${event.seq} has no call id`)
      }
      if (isError) failures.push(`tool result reports error for ${String(callId ?? 'unknown call')}`)
      for (const match of text.matchAll(/\b(error|warning|note)\[(PTC-[A-Z]\d{3})\]:?[^\n]*/g)) {
        const diagnostic = match[0]
        warnings.push(diagnostic)
        if (match[1] === 'error') failures.push(`model encountered a blocking PTC diagnostic: ${diagnostic}`)
      }
    }
  }

  for (const [callId] of calls) if (!results.has(callId)) failures.push(`tool call ${callId} has no matching result`)
  for (const [callId] of results) if (!calls.has(callId)) failures.push(`tool result ${callId} has no matching call`)
  for (const call of calls.values()) {
    if (call.name !== 'run_code') failures.push(`model-facing call bypassed PTC: ${String(call.name)}`)
    if (typeof call.code !== 'string' || typeof call.description !== 'string') {
      failures.push(`run_code call ${call.callId} lacks code or description`)
      continue
    }
    const antiPatterns = [
      [/\btools\s*\./, 'direct tools.* use inside run_code'],
      [/\b(?:pwsh|powershell)\b/i, 'nested PowerShell execution'],
      [/\b(?:readFileSync|writeFileSync|execFileSync|spawnSync)\b/, 'direct host file/process I/O'],
      [/\bnode:(?:fs|child_process|process)\b/, 'ambient Node host access'],
      [/\b(?:const|let|var)\s+\{[^}]*\b(?:repl|workspace|code|host|cordis)\b[^}]*\}\s*=\s*globalThis\b/,
        'redeclares a capability namespace from globalThis'],
      [/host\.invoke\s*\(\s*\{[\s\S]*?name\s*:\s*["']read["']/, 'routes adapted file reads through host.invoke'],
      [/host\.invoke\s*\(\s*\{[\s\S]*?name\s*:\s*["']glob["']/, 'routes adapted file discovery through host.invoke'],
      [/host\.invoke\s*\(\s*\{[\s\S]*?name\s*:\s*["']glob["'][\s\S]*?pattern\s*:\s*["']\*["']/, 'uses recursive glob("*") for root discovery'],
      [/workspace\.findFiles\s*\(\s*\{[\s\S]*?pattern\s*:\s*["']\*\*[\/]\*["']/, 'scans the entire repository for project orientation'],
    ]
    for (const [pattern, label] of antiPatterns) {
      if (pattern.test(call.code)) failures.push(`anti-pattern in call ${call.callId}: ${label}`)
    }
    if (call.code.length > 5000) failures.push(`anti-pattern in call ${call.callId}: oversized source (${call.code.length} chars)`)
  }
  for (const result of results.values()) {
    if (result.journalStatus === undefined) failures.push(`run_code result ${result.callId} has no PTC journal`)
    else if (result.journalStatus !== 'durable') {
      failures.push(`run_code result ${result.callId} is ${result.journalStatus}: ${result.volatileReason ?? 'no reason'}`)
    }
    for (const nested of result.nestedFailures) {
      failures.push(`nested capability failed in ${result.callId}: ${nested.capability}: ${nested.error}`)
    }
    if (result.outputChars >= 50000) failures.push(`capability result ${result.callId} reached the output ceiling (${result.outputChars} chars)`)
    else if (result.outputChars > 25000) failures.push(`capability result ${result.callId} is insufficiently curated (${result.outputChars} chars)`)
  }
  const modelTools = Array.isArray(requestHeader?.tools) ? requestHeader.tools : []
  if (modelTools.length !== 1 || modelTools[0]?.name !== 'run_code') {
    failures.push(`model-visible tools are ${modelTools.map(tool => tool?.name).join(', ') || 'missing'} instead of only run_code`)
  }
  if (!/session-bound persistent REPL/.test(modelTools[0]?.description ?? '')) {
    failures.push('run_code schema does not describe the session-bound persistent REPL')
  }
  const system = typeof requestHeader?.system === 'string' ? requestHeader.system : ''
  if (!/declare const repl:/.test(system) || !/declare const workspace:/.test(system)
    || !/declare const host:/.test(system)) {
    failures.push('program SDK omits repl, workspace, or host')
  }
  for (const conflict of promptConflicts(system)) failures.push(`prompt contradiction: ${conflict}`)
  if (requestHeader?.config?.provider !== 'opencode-go' || requestHeader?.config?.model !== 'deepseek-v4-flash') {
    failures.push(`model route is ${requestHeader?.config?.provider ?? 'missing'}/${requestHeader?.config?.model ?? 'missing'}`)
  }

  const timeline = [...calls.values()].sort((left, right) => left.seq - right.seq).map(call => ({
    ...call,
    ...(results.get(call.callId) ?? { resultMissing: true }),
  }))
  if (timeline.length === 0) failures.push('the task produced no run_code call')
  if (timeline.length > 8) failures.push(`too many run_code calls for project orientation: ${timeline.length}`)
  if (finalTurn?.data?.reason?.kind !== 'completed') {
    failures.push(`turn ended as ${finalTurn?.data?.reason?.kind ?? 'missing'}`)
  }
  if (header?.cwd !== windowsRepoRoot) failures.push(`session cwd is ${String(header?.cwd)} instead of ${windowsRepoRoot}`)
  const finalAnswer = assistantTexts.at(-1) ?? ''
  for (const term of ['dsh-ptc-plus', 'REPL', 'DSH']) {
    if (!finalAnswer.includes(term)) failures.push(`final answer does not identify ${term}`)
  }

  return {
    session: { id: header?.id, cwd: header?.cwd, createdAt: header?.createdAt },
    acceptancePreset: agentPreset,
    model: requestHeader?.config,
    prompt: {
      chars: system.length,
      modelTools: modelTools.map(tool => tool?.name),
      hasReplSdk: /declare const repl:/.test(system),
      hasWorkspaceSdk: /declare const workspace:/.test(system),
      hasHostSdk: /declare const host:/.test(system),
      conflicts: promptConflicts(system),
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

function reportMarkdown(report) {
  const cells = report.timeline.flatMap((cell, index) => [
    `### Cell ${index + 1}: ${cell.description ?? 'missing description'}`,
    '',
    `- seq/call: ${cell.seq} / ${cell.callId}`,
    `- result: ${cell.isError ? 'error' : 'ok'}; journal: ${cell.journalStatus ?? 'missing'}; nested calls/errors: ${cell.nestedCallCount ?? 0}/${cell.nestedFailures?.length ?? 0}; output: ${cell.outputChars ?? 0} chars`,
    '',
    '```ts',
    cell.code ?? '',
    '```',
    '',
  ])
  return [
    '# Expensive DSH headless acceptance',
    '',
    `- task: ${task}`,
    `- session: ${report.session.id ?? 'missing'}`,
    `- cwd: ${report.session.cwd ?? 'missing'}`,
    `- requested agent preset: ${report.acceptancePreset}`,
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
    `| program SDK | repl=${report.prompt.hasReplSdk}, workspace=${report.prompt.hasWorkspaceSdk}, host=${report.prompt.hasHostSdk} |`,
    `| contradictions | ${markdownCell(report.prompt.conflicts.join('; ') || 'none')} |`,
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

await mkdir(artifactRoot, { recursive: true })
const dshHomeWindows = resolveWindowsDshHome()
const dshHome = /^[a-zA-Z]:[\\/]/.test(repoRoot) ? dshHomeWindows : wslPath(dshHomeWindows)
const sessionsRoot = join(dshHome, 'sessions')
const before = await snapshotLogs(sessionsRoot)
const overlay = join(artifactRoot, 'code-preset.patch.yml')
await writeFile(overlay, [
  '- id: agent-presets',
  '  config:',
  `    default: ${agentPreset}`,
  '- id: settings',
  '  disabled: true',
  '- id: agent-default-model',
  '  config:',
  '    provider: opencode-go',
  '    model: deepseek-v4-flash',
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      opencode-go:',
  '        apiKeyEnv: OPENCODE_GO_API_KEY',
  '',
].join('\n'))

const install = await runProcess('pwsh.exe', [
  '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', windowsPath(join(repoRoot, 'scripts', 'install-dev.ps1')), 'headless',
], {
  cwd: repoRoot,
  env: { ...process.env, DSH_DEV_INSTALL_NO_PAUSE: '1' },
  stdoutPath: join(artifactRoot, 'install.stdout.log'),
  stderrPath: join(artifactRoot, 'install.stderr.log'),
})
if (install.code !== 0) throw new Error(`plugin installation failed; see ${relative(repoRoot, artifactRoot)}/install.*.log`)

const startedAt = Date.now()
const run = await runProcess('pwsh.exe', [
  '-NoLogo', '-NoProfile', '-Command',
  `& dsh --profile headless --patch '${powershellPath(windowsPath(overlay))}' '${powershellPath(task)}'`,
], {
  cwd: repoRoot,
  env: { ...process.env, DSH_TOOLS_MODE: 'code' },
  stdoutPath: join(artifactRoot, 'dsh.stdout.log'),
  stderrPath: join(artifactRoot, 'dsh.stderr.log'),
})
if (run.code !== 0) throw new Error(`headless DSH exited with ${run.code}; see ${relative(repoRoot, artifactRoot)}/dsh.*.log`)

const after = await snapshotLogs(sessionsRoot)
const candidates = []
for (const [file, mtime] of after) {
  if (!before.has(file) || mtime > Math.max(startedAt - 1000, before.get(file) ?? 0)) candidates.push(file)
}
const projectCandidates = candidates.filter(file => file.includes('--G-TSWorkSpace-dsh-ptc-plus--'))
if (projectCandidates.length === 0) throw new Error(`no new project session log found under ${sessionsRoot}`)
projectCandidates.sort((left, right) => (after.get(right) ?? 0) - (after.get(left) ?? 0))
const logFile = projectCandidates[0]
const logText = await decodeLog(logFile)
await writeFile(join(artifactRoot, 'session.jsonl'), logText)
const report = inspectLog(parseEvents(logText))
await writeFile(join(artifactRoot, 'analysis.json'), JSON.stringify({ ...report, logFile }, null, 2) + '\n')
await writeFile(join(artifactRoot, 'analysis.md'), reportMarkdown(report))
if (report.failures.length > 0) {
  console.error(`expensive acceptance failed; see ${relative(repoRoot, artifactRoot)}/analysis.md`)
  process.exitCode = 1
} else {
  console.log(`expensive acceptance passed; artifacts: ${relative(repoRoot, artifactRoot)}`)
}
