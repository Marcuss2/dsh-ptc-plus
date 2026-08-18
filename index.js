/**
 * Session-bound REPL for DeepSeek Harness Code Mode.
 *
 * DSH's run_code bridge does not pass session identity to CodeRuntime.run().
 * The tools/execute around-hook carries that identity through AsyncLocalStorage,
 * then this plugin redirects only those runs to a persistent per-session kernel.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { SessionRuntime } from './internal/session-runtime.js'
import { JOURNAL_KEY, journalsEqual, withJournal } from './internal/session-journal.js'
import { decodeValue, encodeValue, isPlainJsonTree } from './internal/value-wire.js'

const RUN_CODE = 'run_code'
const DEFAULT_MAX_NESTED_RUN_CODE_DEPTH = 8
const CORDIS_BINDINGS = Object.freeze({
  inspectList: 'cordis_inspect_list',
  inspect: 'cordis_inspect_query',
  inspectSelf: 'cordis_inspect_self',
  define: 'cordis_define',
  run: 'cordis_run',
  stop: 'cordis_stop',
  undefine: 'cordis_undefine',
})
const CORDIS_NATIVE_NAMES = new Set(Object.values(CORDIS_BINDINGS))
const CORDIS_NATIVE_PREFIX = 'cordis_'
const CORDIS_REPLAY_MEMBERS = new Set(['inspectSelf', 'define', 'run', 'stop', 'undefine'])
const RUN_CODE_TOOL_DESCRIPTION = 'Evaluate the next TypeScript cell in this session-bound persistent REPL. Earlier top-level bindings remain available, so this call extends the current environment instead of creating a fresh one. Use `code` for the async-function body and `description` for its short UI summary. Only printed or returned values are output. Successful image-bearing subtool results are attached after the cell.'
const RUN_CODE_CODE_DESCRIPTION = 'Code for the next REPL cell, parsed as the body of an async TypeScript function.'
const RUN_CODE_DESCRIPTION_DESCRIPTION = 'Short active-voice summary of what this cell does, 5-10 words (shown in the UI).'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ptc-plus'

/** Services required by the plugin. */
export const inject = ['tools', 'codeRuntime', 'systemPrompt']

function replGuidance(looseTopLevelRedeclarations, durableReplay) {
  const redeclaration = looseTopLevelRedeclarations
    ? 'Repeated top-level `const`/`let` variable declarations replace existing bindings; reuse a name naturally when recomputing it. A non-blocking `[PTC-N002]` note after an adjacent redeclaration means the existing binding could have been referenced directly.'
    : 'Redeclaring an existing top-level name fails before execution, so reuse it or place one-off declarations inside a block.'
  const recovery = durableReplay
    ? ''
    : ' Durable replay is disabled for this profile. Bindings remain reusable only in the current process; a new kernel starts empty.'
  return `\`run_code\` evaluates consecutive top-level cells in one session-bound persistent REPL.

## session-bound REPL
Reuse existing top-level bindings and do not resend setup source. ${redeclaration}${recovery} Use the current SDK-declared capability globals such as \`workspace\`, \`code\`, \`host\`, and optional \`cordis\`; they are rebound for every cell, so never retain an individual capability function. Direct non-journalable Node/process access changes only cold recovery; live bindings remain usable. Follow \`[PTC-...]\` \`help:\` lines and retry only the failing part. Use \`code.run({ code, description })\` to execute source constructed or transformed by this cell in an isolated child environment; it returns \`{ logs, result? }\`. Historical source may be read through available session-event capabilities and edited with ordinary TypeScript.`
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCordisNativeName(value) {
  return typeof value === 'string' && value.startsWith(CORDIS_NATIVE_PREFIX)
}

function isCordisReplayMember(global, member) {
  return global === 'cordis' && CORDIS_REPLAY_MEMBERS.has(member)
}

const CORDIS_ID_FIELDS = new Set(['pluginId', 'packageId', 'pluginRunId', 'currentPackageId', 'nextPackageId'])
function cordisMapKey(field, value) {
  return `${field}:${value}`
}

function rewriteCordisIds(value, mapping) {
  if (Array.isArray(value)) return value.map(item => rewriteCordisIds(item, mapping))
  if (value === null || typeof value !== 'object') return value
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = CORDIS_ID_FIELDS.has(key) && typeof item === 'string' && mapping.has(cordisMapKey(key, item))
      ? mapping.get(cordisMapKey(key, item))
      : rewriteCordisIds(item, mapping)
  }
  return result
}

function bindCordisIdentity(state, field, logical, runtime, path) {
  const knownRuntime = state.logicalToRuntime.get(cordisMapKey(field, logical))
  const knownLogical = state.runtimeToLogical.get(cordisMapKey(field, runtime))
  if ((knownRuntime !== undefined && knownRuntime !== runtime)
    || (knownLogical !== undefined && knownLogical !== logical)) {
    throw new Error(`Cordis replay identity diverged at ${path}`)
  }
  state.logicalToRuntime.set(cordisMapKey(field, logical), runtime)
  state.runtimeToLogical.set(cordisMapKey(field, runtime), logical)
}

function seedCordisIdentities(logical, runtime, state, path = '$') {
  if (Array.isArray(logical) && Array.isArray(runtime)) {
    for (let index = 0; index < Math.min(logical.length, runtime.length); index += 1) {
      seedCordisIdentities(logical[index], runtime[index], state, `${path}[${index}]`)
    }
    return
  }
  if (logical === null || runtime === null || typeof logical !== 'object' || typeof runtime !== 'object') return
  for (const key of Object.keys(logical)) {
    const left = logical[key]
    const right = runtime[key]
    if (CORDIS_ID_FIELDS.has(key) && typeof left === 'string' && typeof right === 'string') {
      bindCordisIdentity(state, key, left, right, `${path}.${key}`)
    } else {
      seedCordisIdentities(left, right, state, `${path}.${key}`)
    }
  }
}

function alignCordisValue(logical, runtime, state, path = '$') {
  if (Array.isArray(logical) || Array.isArray(runtime)) {
    if (!Array.isArray(logical) || !Array.isArray(runtime) || logical.length !== runtime.length) {
      throw new Error(`Cordis replay result diverged at ${path}`)
    }
    return logical.map((item, index) => alignCordisValue(item, runtime[index], state, `${path}[${index}]`))
  }
  if (logical !== null && typeof logical === 'object' && runtime !== null && typeof runtime === 'object') {
    const logicalKeys = Object.keys(logical).sort()
    const runtimeKeys = Object.keys(runtime).sort()
    if (logicalKeys.length !== runtimeKeys.length || logicalKeys.some((key, index) => key !== runtimeKeys[index])) {
      throw new Error(`Cordis replay result diverged at ${path}`)
    }
    const result = {}
    for (const key of logicalKeys) {
      const left = logical[key]
      const right = runtime[key]
      if (CORDIS_ID_FIELDS.has(key) && typeof left === 'string' && typeof right === 'string') {
        bindCordisIdentity(state, key, left, right, `${path}.${key}`)
        result[key] = left
      } else {
        result[key] = alignCordisValue(left, right, state, `${path}.${key}`)
      }
    }
    return result
  }
  if (!Object.is(logical, runtime)) throw new Error(`Cordis replay result diverged at ${path}`)
  return logical
}

function trackCordisReplay(state, member, args, result) {
  const livePlugins = state.livePlugins ??= new Set()
  const creationOrder = state.creationOrder ??= []
  if (member === 'define' && args?.target?.kind === 'new' && typeof result?.pluginId === 'string') {
    if (!livePlugins.has(result.pluginId)) creationOrder.push(result.pluginId)
    livePlugins.add(result.pluginId)
  } else if (member === 'undefine' && typeof args?.pluginId === 'string') {
    livePlugins.delete(args.pluginId)
  }
}

async function rollbackCordisReplay({ state, request }) {
  const cordisState = state?.cordis
  if (cordisState?.livePlugins?.size === 0 || cordisState?.livePlugins === undefined) return
  const cordis = request.bindings.find(namespace => namespace.global === 'cordis')?.functions
  if (typeof cordis?.undefine !== 'function') throw new Error('Cordis undefine binding is unavailable')
  for (const pluginId of [...cordisState.creationOrder].reverse()) {
    if (!cordisState.livePlugins.has(pluginId)) continue
    await cordis.undefine({ pluginId })
    cordisState.livePlugins.delete(pluginId)
  }
}

function cordisReplayBinding({ global, member, args, recorded, binding, state, request, replayRecord, callIndex, valueLimits }) {
  if (global === 'code' && member === 'run') {
    const effects = replayRecord?.cordisEffects?.filter(effect => effect.parent === callIndex) ?? []
    if (effects.length === 0) return undefined
    const cordisNamespace = request.bindings.find(namespace => namespace.global === 'cordis')
    if (cordisNamespace?.functions === undefined) throw new Error('Cordis replay requires the typed capability profile')
    const cordisState = state.cordis ??= {
      logicalToRuntime: new Map(),
      runtimeToLogical: new Map(),
    }
    return (async () => {
      for (const effect of effects) {
        const effectBinding = cordisNamespace.functions[effect.member]
        if (typeof effectBinding !== 'function') throw new Error(`Cordis replay binding ${effect.member} is unavailable`)
        if (effect.ok !== true) throw new Error(`Cordis replay cannot restore failed ${effect.member} effect`)
        const logicalArgs = decodeValue(effect.args, valueLimits)
        const actual = await effectBinding(rewriteCordisIds(logicalArgs, cordisState.logicalToRuntime))
        const logical = decodeValue(effect.value, valueLimits)
        seedCordisIdentities(logical, actual, cordisState)
        if (effect.member === 'define') trackCordisReplay(cordisState, effect.member, logicalArgs, logical)
        alignCordisValue(logical, actual, cordisState)
        if (effect.member !== 'define') trackCordisReplay(cordisState, effect.member, logicalArgs, logical)
      }
      return { ok: true, value: decodeValue(recorded.value, valueLimits) }
    })()
  }
  if (!isCordisReplayMember(global, member)) return undefined
  const cordisState = state.cordis ??= {
    logicalToRuntime: new Map(),
    runtimeToLogical: new Map(),
  }
  const mappedArgs = rewriteCordisIds(args, cordisState.logicalToRuntime)
  return (async () => {
    let actual
    try {
      actual = await binding(mappedArgs)
    } catch (error) {
      if (recorded.ok !== false) throw error
      const actualMessage = error?.message === undefined ? String(error) : String(error.message)
      if (actualMessage !== recorded.error) {
        throw new Error(`Cordis replay failure diverged: expected ${JSON.stringify(recorded.error)}, got ${JSON.stringify(actualMessage)}`)
      }
      return { ok: false, error: recorded.error }
    }
    if (recorded.ok !== true) {
      throw new Error(`Cordis replay succeeded where ${JSON.stringify(recorded.error)} was recorded`)
    }
    const logical = decodeValue(recorded.value, valueLimits)
    seedCordisIdentities(logical, actual, cordisState)
    if (member === 'define') trackCordisReplay(cordisState, member, args, logical)
    const aligned = alignCordisValue(logical, actual, cordisState)
    if (member !== 'define') trackCordisReplay(cordisState, member, args, aligned)
    return { ok: true, value: aligned }
  })()
}

function supportsCordisProfile(names) {
  const present = new Set([...names].filter(isCordisNativeName))
  return present.size === CORDIS_NATIVE_NAMES.size
    && [...CORDIS_NATIVE_NAMES].every(name => present.has(name))
}

function adaptCordisGuidance(value) {
  if (typeof value !== 'string') {
    throw new Error('ptc-plus: incompatible Cordis guidance; expected rendered text')
  }
  let text = value
    .replaceAll('cordis_inspect_self(pluginId, packageId)', 'cordis.inspectSelf({ pluginId, packageId })')
  for (const [member, nativeName] of Object.entries(CORDIS_BINDINGS)) {
    text = text.replaceAll(nativeName, `cordis.${member}`)
  }
  text = text
    .replaceAll('idPrefix', 'target.prefix')
    .replaceAll('code.host', 'source.host')
    .replaceAll('code.client', 'source.client')
    .replaceAll('workflow and Tools', 'workflow and program APIs')
    .replaceAll('instructions or Tools', 'instructions or program APIs')
    .replaceAll('inside a Tool', 'inside a run_code cell')
    .replaceAll('the Tool is cancelled', 'the run_code cell is cancelled')
  if (/\bcordis_[a-z0-9_]+\b/.test(text)) {
    throw new Error('ptc-plus: incompatible Cordis guidance; unknown native API reference')
  }
  return `# Cordis program interface

All Cordis operations below are methods on the optional \`cordis\` namespace inside \`run_code\`; they are not model-callable tools. Follow the program SDK for exact argument shapes.

${text}`
}

function adaptRunCodeSchema(tool) {
  const parameters = tool.parameters
  const properties = isRecord(parameters) ? parameters.properties : undefined
  const code = isRecord(properties) ? properties.code : undefined
  const description = isRecord(properties) ? properties.description : undefined
  if (!isRecord(parameters) || parameters.type !== 'object' || !isRecord(properties)
    || !isRecord(code) || code.type !== 'string'
    || !isRecord(description) || description.type !== 'string') {
    throw new Error('ptc-plus: incompatible run_code schema; expected object parameters with string code and description properties')
  }
  return {
    ...tool,
    description: RUN_CODE_TOOL_DESCRIPTION,
    parameters: {
      ...parameters,
      properties: {
        ...properties,
        code: { ...code, description: RUN_CODE_CODE_DESCRIPTION },
        description: { ...description, description: RUN_CODE_DESCRIPTION_DESCRIPTION },
      },
    },
  }
}

function sessionId(agent) {
  const id = agent?.session?.id ?? agent?.id
  return id === undefined ? undefined : String(id)
}

function nestedRunCodeArguments(value) {
  if (!isRecord(value)) {
    throw new TypeError('code.run expects an object with code and description strings')
  }
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 2 || !keys.includes('code') || !keys.includes('description')
    || keys.some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))
    || typeof value.code !== 'string' || typeof value.description !== 'string') {
    throw new TypeError('code.run expects exactly code and description string properties')
  }
  return { code: value.code, description: value.description }
}

function exactObject(value, fields, label) {
  if (!isRecord(value)) throw new TypeError(`${label} expects an object`)
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || !fields.has(key)
    || !Object.prototype.propertyIsEnumerable.call(value, key))) {
    throw new TypeError(`${label} received unknown or non-enumerable fields`)
  }
  return value
}

function readLinesArguments(value) {
  exactObject(value, new Set(['path', 'offset', 'limit']), 'workspace.readLines')
  if (typeof value.path !== 'string' || value.path.trim().length === 0) {
    throw new TypeError('workspace.readLines path must be a non-empty string')
  }
  for (const name of ['offset', 'limit']) {
    if (value[name] !== undefined && (!Number.isSafeInteger(value[name]) || value[name] < 1)) {
      throw new TypeError(`workspace.readLines ${name} must be a positive integer`)
    }
  }
  return {
    file_path: value.path,
    ...(value.offset === undefined ? {} : { offset: value.offset }),
    ...(value.limit === undefined ? {} : { limit: value.limit }),
  }
}

function dataField(value, name, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
    throw new TypeError(`${label} ${name} must be an enumerable data property`)
  }
  return descriptor.value
}

function readLinesResult(value) {
  const label = 'workspace.readLines host result'
  exactObject(value, new Set(['path', 'offset', 'lines', 'totalLines']), label)
  const path = dataField(value, 'path', label)
  const offset = dataField(value, 'offset', label)
  const lines = dataField(value, 'lines', label)
  const totalLines = dataField(value, 'totalLines', label)
  if (typeof path !== 'string' || path.length === 0) throw new TypeError(`${label} path must be a non-empty string`)
  if (!Number.isSafeInteger(offset) || offset < 1) throw new TypeError(`${label} offset must be a positive integer`)
  if (!Number.isSafeInteger(totalLines) || totalLines < 0) {
    throw new TypeError(`${label} totalLines must be a non-negative integer`)
  }
  if (!Array.isArray(lines)) throw new TypeError(`${label} lines must be an array`)
  const projectedLines = lines.map((line, index) => {
    const lineLabel = `${label} lines[${index}]`
    exactObject(line, new Set(['number', 'text']), lineLabel)
    const number = dataField(line, 'number', lineLabel)
    const text = dataField(line, 'text', lineLabel)
    if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${lineLabel} number must be a positive integer`)
    if (typeof text !== 'string') throw new TypeError(`${lineLabel} text must be a string`)
    return { number, text }
  })
  return { path, offset, lines: projectedLines, totalLines }
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`)
  return value
}

function noArguments(value, label) {
  if (value !== undefined) throw new TypeError(`${label} does not accept arguments`)
}

function cordisInspectArguments(value) {
  exactObject(value, new Set(['platform', 'provider', 'method', 'input']), 'cordis.inspect')
  if (!['host', 'client'].includes(value.platform)) throw new TypeError('cordis.inspect platform must be host or client')
  const provider = nonEmptyString(value.provider, 'cordis.inspect provider')
  const method = nonEmptyString(value.method, 'cordis.inspect method')
  return {
    platform: value.platform,
    provider,
    method,
    ...(value.input === undefined ? {} : { input: value.input }),
  }
}

function cordisInspectSelfArguments(value) {
  if (value === undefined) return {}
  exactObject(value, new Set(['pluginId', 'packageId']), 'cordis.inspectSelf')
  if (value.packageId !== undefined && value.pluginId === undefined) {
    throw new TypeError('cordis.inspectSelf packageId requires pluginId')
  }
  return {
    ...(value.pluginId === undefined ? {} : { pluginId: nonEmptyString(value.pluginId, 'cordis.inspectSelf pluginId') }),
    ...(value.packageId === undefined ? {} : { packageId: nonEmptyString(value.packageId, 'cordis.inspectSelf packageId') }),
  }
}

function cordisDefineArguments(value) {
  exactObject(value, new Set(['target', 'name', 'purpose', 'source']), 'cordis.define')
  exactObject(value.target, new Set(['kind', 'prefix', 'pluginId']), 'cordis.define target')
  let plugin
  if (value.target.kind === 'new') {
    if (Object.hasOwn(value.target, 'pluginId')) throw new TypeError('cordis.define new target cannot include pluginId')
    plugin = { kind: 'new', idPrefix: nonEmptyString(value.target.prefix, 'cordis.define target prefix') }
  } else if (value.target.kind === 'existing') {
    if (Object.hasOwn(value.target, 'prefix')) throw new TypeError('cordis.define existing target cannot include prefix')
    plugin = { kind: 'existing', pluginId: nonEmptyString(value.target.pluginId, 'cordis.define target pluginId') }
  } else {
    throw new TypeError('cordis.define target kind must be new or existing')
  }
  exactObject(value.source, new Set(['host', 'client']), 'cordis.define source')
  if (value.source.host === undefined && value.source.client === undefined) {
    throw new TypeError('cordis.define source requires host or client')
  }
  for (const key of ['host', 'client']) {
    if (value.source[key] !== undefined && typeof value.source[key] !== 'string') {
      throw new TypeError(`cordis.define source ${key} must be a string`)
    }
  }
  return {
    plugin,
    name: nonEmptyString(value.name, 'cordis.define name'),
    purpose: nonEmptyString(value.purpose, 'cordis.define purpose'),
    code: {
      ...(value.source.host === undefined ? {} : { host: value.source.host }),
      ...(value.source.client === undefined ? {} : { client: value.source.client }),
    },
  }
}

function cordisRunArguments(value) {
  exactObject(value, new Set(['pluginId', 'packageId', 'mode']), 'cordis.run')
  if (!['run', 'update'].includes(value.mode)) throw new TypeError('cordis.run mode must be run or update')
  return {
    pluginId: nonEmptyString(value.pluginId, 'cordis.run pluginId'),
    packageId: nonEmptyString(value.packageId, 'cordis.run packageId'),
    mode: value.mode,
  }
}

function cordisPluginArguments(value, operation) {
  exactObject(value, new Set(['pluginId']), `cordis.${operation}`)
  return { pluginId: nonEmptyString(value.pluginId, `cordis.${operation} pluginId`) }
}

function cordisJsonResult(value, label, limits) {
  let projected
  try {
    projected = decodeValue(encodeValue(value, limits), limits)
  } catch (error) {
    throw new TypeError(`${label} must be a plain JSON tree: ${error.message}`)
  }
  if (!isPlainJsonTree(projected)) throw new TypeError(`${label} must be a plain JSON tree`)
  return projected
}

function cordisInspectListResult(value, limits) {
  exactObject(value, new Set(['providers']), 'cordis.inspectList host result')
  const providers = dataField(value, 'providers', 'cordis.inspectList host result')
  if (!Array.isArray(providers)) throw new TypeError('cordis.inspectList host result providers must be an array')
  return cordisJsonResult(providers, 'cordis.inspectList host result providers', limits)
}

function cordisInspectResult(value, args, limits) {
  const label = 'cordis.inspect host result'
  exactObject(value, new Set(['platform', 'provider', 'method', 'data']), label)
  if (dataField(value, 'platform', label) !== args.platform
    || dataField(value, 'provider', label) !== args.provider
    || dataField(value, 'method', label) !== args.method) {
    throw new TypeError(`${label} does not match the request`)
  }
  return cordisJsonResult(dataField(value, 'data', label), `${label} data`, limits)
}

function cordisDefineResult(value) {
  const label = 'cordis.define host result'
  exactObject(value, new Set(['pluginId', 'packageId', 'name', 'purpose', 'hasHostHalf', 'hasClientHalf']), label)
  const result = {
    pluginId: nonEmptyString(dataField(value, 'pluginId', label), `${label} pluginId`),
    packageId: nonEmptyString(dataField(value, 'packageId', label), `${label} packageId`),
    name: nonEmptyString(dataField(value, 'name', label), `${label} name`),
    purpose: nonEmptyString(dataField(value, 'purpose', label), `${label} purpose`),
    hasHostHalf: dataField(value, 'hasHostHalf', label),
    hasClientHalf: dataField(value, 'hasClientHalf', label),
  }
  if (typeof result.hasHostHalf !== 'boolean' || typeof result.hasClientHalf !== 'boolean') {
    throw new TypeError(`${label} half-presence fields must be booleans`)
  }
  return result
}

function cordisPluginResult(value, operation, includeWasRunning = false) {
  const label = `cordis.${operation} host result`
  exactObject(value, new Set(includeWasRunning ? ['pluginId', 'wasRunning'] : ['pluginId']), label)
  const result = { pluginId: nonEmptyString(dataField(value, 'pluginId', label), `${label} pluginId`) }
  if (!includeWasRunning) return result
  const wasRunning = dataField(value, 'wasRunning', label)
  if (typeof wasRunning !== 'boolean') throw new TypeError(`${label} wasRunning must be a boolean`)
  return { ...result, wasRunning }
}

function hostInvokeArguments(value) {
  exactObject(value, new Set(['name', 'args']), 'host.invoke')
  if (typeof value.name !== 'string' || value.name.length === 0 || !Object.hasOwn(value, 'args')) {
    throw new TypeError('host.invoke expects non-empty name and args properties')
  }
  return { name: value.name, args: value.args }
}

function namespace(global, functions, errorName, memberNameProperty) {
  return {
    global,
    functions,
    errorClass: { name: errorName, memberNameProperty },
  }
}

function capabilitySdk(names) {
  const available = new Set(names)
  const hasCordis = supportsCordisProfile(available)
  const compatibility = [...available]
    .filter(name => name !== RUN_CODE && !(hasCordis && isCordisNativeName(name)))
    .sort()
  const hostNames = compatibility.length === 0 ? 'never' : compatibility.map(JSON.stringify).join(' | ')
  const workspace = available.has('read')
    ? `interface WorkspaceLine { number: number; text: string }
interface WorkspaceLines { path: string; offset: number; lines: WorkspaceLine[]; totalLines: number }
declare class WorkspaceError extends Error { readonly operation: "readLines" }
declare const workspace: {
  readLines(args: { path: string; offset?: number; limit?: number }): Promise<WorkspaceLines>
}`
    : ''
  const cordis = hasCordis
    ? `type CordisJson = HostJson
declare class CordisError extends Error { readonly operation: "inspectList" | "inspect" | "inspectSelf" | "define" | "run" | "stop" | "undefine" }
declare const cordis: {
  inspectList(): Promise<CordisJson[]>
  inspect(args: { platform: "host" | "client"; provider: string; method: string; input?: CordisJson }): Promise<CordisJson>
  inspectSelf(args?: { pluginId?: string; packageId?: string }): Promise<CordisJson>
  define(args: {
    target: { kind: "new"; prefix: string } | { kind: "existing"; pluginId: string }
    name: string
    purpose: string
    source: { host?: string; client?: string }
  }): Promise<{ pluginId: string; packageId: string; name: string; purpose: string; hasHostHalf: boolean; hasClientHalf: boolean }>
  run(args: { pluginId: string; packageId: string; mode: "run" | "update" }): Promise<CordisJson>
  stop(args: { pluginId: string }): Promise<{ pluginId: string }>
  undefine(args: { pluginId: string }): Promise<{ pluginId: string; wasRunning: boolean }>
}`
    : ''
  return `## Program capabilities

Only \`run_code\` is model-callable. Inside a cell, use these program APIs; do not emit native tool calls or \`tools.*\` expressions. Capability objects are rebound for each cell.

\`\`\`ts
type HostJson = null | boolean | number | string | HostJson[] | { [key: string]: HostJson }
${workspace}
${cordis}

declare class CodeExecutionError extends Error { readonly operation: "run" }
declare const code: {
  run(args: { code: string; description: string }): Promise<{ logs: string[]; result?: HostJson }>
}

type HostCapabilityName = ${hostNames}
declare class HostCapabilityError extends Error { readonly operation: "invoke" }
declare const host: {
  invoke(call: { name: HostCapabilityName; args: HostJson }): Promise<HostJson>
}
\`\`\`

\`workspace.readLines\` is intentionally bounded and never claims to return a complete file. \`cordis\` exists only when the exact known Cordis binding profile is present. \`host.invoke\` is the explicit compatibility path for other unadapted capabilities.`
}

/** Register the session-bound REPL runtime. */
export function apply(ctx, config = {}) {
  if (ctx.codeRuntime.language !== 'typescript') {
    throw new Error(`ptc-plus: unsupported code runtime language ${JSON.stringify(ctx.codeRuntime.language)}; only "typescript" is supported`)
  }

  const maxNestedRunCodeDepth = config.maxNestedRunCodeDepth ?? DEFAULT_MAX_NESTED_RUN_CODE_DEPTH
  if (!Number.isSafeInteger(maxNestedRunCodeDepth) || maxNestedRunCodeDepth < 1) {
    throw new TypeError('ptc-plus: maxNestedRunCodeDepth must be a positive safe integer')
  }
  const { maxNestedRunCodeDepth: _nestedDepth, ...sessionConfig } = config
  const looseTopLevelRedeclarations = config.looseTopLevelRedeclarations ?? true
  const scope = new AsyncLocalStorage()
  const sessions = new SessionRuntime({
    ...sessionConfig,
    replayBinding: cordisReplayBinding,
    rollbackReplay: rollbackCordisReplay,
  })
  const cordisValueLimits = {
    maxNodes: sessions.config.maxValueNodes,
    maxEdges: sessions.config.maxValueEdges,
    maxArrayLength: sessions.config.maxValueArrayLength,
    maxBigIntDigits: sessions.config.maxValueBigIntDigits,
    maxStringBytes: sessions.config.maxOutputBytes,
  }
  const runtime = ctx.codeRuntime
  const ownRun = Object.getOwnPropertyDescriptor(runtime, 'run')
  const upstreamRun = runtime.run
  const patchedDefinitions = new Map()
  const pending = new WeakMap()

  const projectBindings = (request, depth, executionToken, inheritedTools = undefined) => {
    const lease = { active: true }
    const release = () => { lease.active = false }
    if (!Array.isArray(request.bindings)) return { request, release }
    const toolsNamespace = request.bindings.find(binding => binding?.global === 'tools')
    const functions = inheritedTools ?? toolsNamespace?.functions
    if (functions === null || typeof functions !== 'object') return { request, release }
    const ensureLease = () => {
      if (!lease.active) throw new Error('PTC execution lease expired')
    }
    const runCode = async (value) => {
      ensureLease()
      const args = nestedRunCodeArguments(value)
      if (depth >= maxNestedRunCodeDepth) {
        throw new RangeError(`code.run recursion depth exceeds configured maximum ${maxNestedRunCodeDepth}`)
      }
      if (typeof functions[RUN_CODE] === 'function') return functions[RUN_CODE](args)
      const childProjected = projectBindings(
        { ...request, program: args.code }, depth + 1, executionToken, functions,
      )
      let child
      try {
        child = await upstreamRun.call(runtime, childProjected.request)
      } finally {
        childProjected.release()
      }
      if (child.error !== undefined) {
        throw new Error(`nested run_code failed (${child.error.kind}): ${child.error.message}`)
      }
      return { logs: child.logs, ...(child.value === undefined ? {} : { result: child.value }) }
    }

    const projected = request.bindings.filter(binding => !['tools', 'workspace', 'cordis', 'code', 'host'].includes(binding?.global))
    if (typeof functions.read === 'function') {
      projected.push(namespace(
        'workspace',
        { readLines: async value => {
          ensureLease()
          return readLinesResult(await functions.read(readLinesArguments(value)))
        } },
        'WorkspaceError',
        'operation',
      ))
    }
    const functionNames = Reflect.ownKeys(functions).filter(key => typeof key === 'string')
    const hasCordis = supportsCordisProfile(functionNames)
      && [...CORDIS_NATIVE_NAMES].every(name => typeof functions[name] === 'function')
    if (hasCordis) {
      const mutate = async (member, programArgs, nativeArgs, project) => {
        if (executionToken !== undefined) sessions.markPendingVolatile(executionToken, `cordis.${member}`)
        let settled = false
        try {
          const runtimeArgs = rewriteCordisIds(
            nativeArgs,
            sessions.cordisIdentityMap(executionToken) ?? new Map(),
          )
          const value = await functions[CORDIS_BINDINGS[member]](runtimeArgs)
          settled = true
          const result = project(value)
          const logicalResult = rewriteCordisIds(
            result,
            sessions.cordisIdentityMap(executionToken, 'runtimeToLogical') ?? new Map(),
          )
          const effectRecorded = sessions.recordCordisEffect(
            executionToken,
            { member, args: programArgs, value: logicalResult },
          )
          if (executionToken !== undefined && !effectRecorded) {
            sessions.markVolatile(executionToken, `cordis.${member}`)
          }
          if (member === 'run' && (!isRecord(logicalResult) || logicalResult.status !== 'running')) {
            if (executionToken !== undefined) sessions.markVolatile(executionToken, `cordis.${member}`)
          }
          return logicalResult
        } catch (error) {
          if (executionToken !== undefined && (settled || member !== 'define')) {
            sessions.markVolatile(executionToken, `cordis.${member}`)
          }
          throw error
        }
      }
      projected.push(namespace('cordis', {
        inspectList: async value => {
          ensureLease()
          noArguments(value, 'cordis.inspectList')
          return cordisInspectListResult(await functions.cordis_inspect_list({}), cordisValueLimits)
        },
        inspect: async value => {
          ensureLease()
          const args = cordisInspectArguments(value)
          return cordisInspectResult(await functions.cordis_inspect_query(args), args, cordisValueLimits)
        },
        inspectSelf: async value => {
          ensureLease()
          const nativeArgs = cordisInspectSelfArguments(value)
          const runtimeArgs = rewriteCordisIds(
            nativeArgs,
            sessions.cordisIdentityMap(executionToken) ?? new Map(),
          )
          const result = cordisJsonResult(
            await functions.cordis_inspect_self(runtimeArgs),
            'cordis.inspectSelf host result',
            cordisValueLimits,
          )
          return rewriteCordisIds(result, sessions.cordisIdentityMap(executionToken, 'runtimeToLogical') ?? new Map())
        },
        define: value => {
          ensureLease()
          return mutate('define', value, cordisDefineArguments(value), cordisDefineResult)
        },
        run: value => {
          ensureLease()
          return mutate(
            'run',
            value,
            cordisRunArguments(value),
            result => cordisJsonResult(result, 'cordis.run host result', cordisValueLimits),
          )
        },
        stop: value => {
          ensureLease()
          return mutate('stop', value, cordisPluginArguments(value, 'stop'), result => cordisPluginResult(result, 'stop'))
        },
        undefine: value => {
          ensureLease()
          return mutate(
            'undefine',
            value,
            cordisPluginArguments(value, 'undefine'),
            result => cordisPluginResult(result, 'undefine', true),
          )
        },
      }, 'CordisError', 'operation'))
    }
    projected.push(namespace('code', { run: runCode }, 'CodeExecutionError', 'operation'))
    const compatible = new Map()
    for (const key of Reflect.ownKeys(functions)) {
      if (typeof key !== 'string' || key === RUN_CODE || (hasCordis && isCordisNativeName(key))
        || typeof functions[key] !== 'function') continue
      compatible.set(key, functions[key])
    }
    projected.push(namespace('host', {
      invoke(value) {
        ensureLease()
        const call = hostInvokeArguments(value)
        const binding = compatible.get(call.name)
        if (binding === undefined) throw new RangeError(`host capability ${JSON.stringify(call.name)} is unavailable`)
        if (executionToken !== undefined && isCordisNativeName(call.name)) {
          sessions.markVolatile(executionToken, `host.invoke(${call.name})`)
        }
        return binding(call.args)
      },
    }, 'HostCapabilityError', 'operation'))
    return { request: { ...request, bindings: projected }, release }
  }

  const patchResultMetadata = (agent) => {
    const definition = ctx.tools.get(RUN_CODE, agent)
    if (definition === undefined) {
      throw new Error('ptc-plus: run_code definition is unavailable for the owning session')
    }
    if (definition.output === undefined) {
      throw new Error('ptc-plus: run_code definition has no output projection')
    }
    if (patchedDefinitions.has(definition)) return
    const output = definition.output
    const original = output.presentationMeta
    const patched = (args, value) => {
      const base = original === undefined ? undefined : original(args, value)
      const current = scope.getStore()
      return current?.journal === undefined ? base : withJournal(base, current.journal)
    }
    try {
      Object.defineProperty(output, 'presentationMeta', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: patched,
      })
      patchedDefinitions.set(definition, { output, original, patched })
    } catch (error) {
      throw new Error(`ptc-plus: cannot attach the session journal to run_code results: ${error.message}`)
    }
  }

  const patchedRun = function (request) {
    const current = scope.getStore()
    if (current === undefined) return upstreamRun.call(runtime, request)
    const projected = projectBindings(request, 0, current)
    return sessions.run(current, { ...projected.request, executionToken: current }).finally(projected.release)
  }

  Object.defineProperty(runtime, 'run', {
    configurable: true,
    writable: true,
    value: patchedRun,
  })

  ctx.systemPrompt.section({
    name: 'tools:ptc-plus-repl',
    order: 98,
    text: context => ctx.tools.get(RUN_CODE, context.scope) === undefined
      ? ''
      : replGuidance(looseTopLevelRedeclarations, sessions.config.durableReplay),
  })

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const tools = assembly.tools
    if (!Array.isArray(tools)) {
      throw new Error('ptc-plus: incompatible prompt assembly; expected a tools array')
    }
    if (!tools.some(tool => tool?.name === RUN_CODE)) return assembly
    const strictPtc = tools.length === 1 && tools[0]?.name === RUN_CODE
    const schemas = strictPtc && typeof ctx.tools.schemas === 'function'
      ? ctx.tools.schemas(context.scope)
      : []
    const names = schemas.map(schema => schema?.name).filter(name => typeof name === 'string')
    const hasRead = names.includes('read')
    const hasCordis = supportsCordisProfile(names)
    const hasCordisGuidance = assembly.sections?.some(section => section?.name === 'tool:cordis') === true
    if (hasCordis && !hasCordisGuidance) {
      throw new Error('ptc-plus: incompatible prompt assembly; Cordis profile has no guidance section')
    }
    return {
      ...assembly,
      tools: tools.map(tool => tool?.name === RUN_CODE ? adaptRunCodeSchema(tool) : tool),
      sections: !strictPtc || !Array.isArray(assembly.sections)
        ? assembly.sections
        : assembly.sections.flatMap((section) => {
            if (hasRead && section?.name === 'tool:read') return []
            if (section?.name === 'tool:cordis') {
              return hasCordis ? [{ ...section, text: adaptCordisGuidance(section.text) }] : []
            }
            return [section?.name === 'tools:sdk'
              ? { ...section, text: capabilitySdk(names) }
              : section]
          }),
    }
  })

  ctx.on('tools/execute', (exec, next) => {
    if (exec.name !== RUN_CODE) return next()
    if (exec.parent !== undefined) return scope.run(undefined, next)
    const id = sessionId(exec.agent)
    if (id === undefined) return next()
    patchResultMetadata(exec.agent)
    const current = { id, callId: String(exec.callId), session: exec.agent?.session }
    pending.set(exec, current)
    return scope.run(current, async () => {
      const result = await next()
      if (result?.isError === true && current.journal !== undefined) {
        return { ...result, meta: withJournal(result.meta, current.journal) }
      }
      return result
    })
  })

  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== RUN_CODE) return
    if (exec.parent !== undefined) return
    const id = sessionId(exec.agent)
    if (id === undefined) return
    const current = pending.get(exec)
    pending.delete(exec)
    if (current?.journal === undefined) {
      sessions.noteNoop(id, exec.callId)
      return
    }
    const meta = result?.meta
    const confirmed = meta !== null && typeof meta === 'object' && !Array.isArray(meta)
      && Object.hasOwn(meta, JOURNAL_KEY)
      && journalsEqual(meta[JOURNAL_KEY], current.journal)
    sessions.finalize(current, confirmed)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    return sessions.disposeSession(sessionId(agent) ?? String(agent.id))
  })
  ctx.on('session/disposed', (session) => {
    return sessions.disposeSession(String(session.id))
  })

  ctx.effect(() => async () => {
    if (runtime.run === patchedRun) {
      if (ownRun === undefined) delete runtime.run
      else Object.defineProperty(runtime, 'run', ownRun)
    }
    for (const { output, original, patched } of patchedDefinitions.values()) {
      if (output.presentationMeta !== patched) continue
      if (original === undefined) delete output.presentationMeta
      else output.presentationMeta = original
    }
    patchedDefinitions.clear()
    await sessions.dispose()
  }, 'ptc-plus session runtime teardown')
}
