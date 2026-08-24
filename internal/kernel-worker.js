import { AsyncLocalStorage } from 'node:async_hooks'
import { registerHooks } from 'node:module'
import { isAbsolute, parse, resolve, sep } from 'node:path'
import repl from 'node:repl'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { formatWithOptions, promisify } from 'node:util'
import { MessageChannel, parentPort, workerData } from 'node:worker_threads'
import { synchronizeBuiltinEsmExports } from './builtin-esm-sync.js'
import { errorDetails, messageOf } from './failure-reporting.js'
import { AMBIENT_GLOBALS, DURABLE_IMPORTS, FORBIDDEN_IMPORTS } from './module-policy.js'
import { decodeValue, encodeValue } from './value-wire.js'

const nativeResolve = resolve

if (parentPort === null) throw new Error('ptc-plus kernel worker started without a parent port')
const { port1, port2: channel } = new MessageChannel()

const input = new PassThrough()
const output = new PassThrough()
output.resume()
const sessionCwd = typeof workerData?.cwd === 'string' ? workerData.cwd : undefined
if (sessionCwd !== undefined && !isAbsolute(sessionCwd)) {
  throw new Error(`ptc-plus session cwd must be absolute, got ${JSON.stringify(sessionCwd)}`)
}
const server = repl.start({
  input,
  output,
  terminal: false,
  prompt: '',
  useGlobal: false,
  ignoreUndefined: true,
})
const context = server.context
const REPL_IMPORT_CANARY = 'data:text/javascript,export default 1'
let replParent
const sessionReplParent = sessionCwd === undefined ? undefined : pathToFileURL(resolve(sessionCwd, 'repl')).href
const staticAdapterParents = new Set()
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === REPL_IMPORT_CANARY && replParent === undefined) replParent = context.parentURL
    return nextResolve(specifier, context.parentURL === replParent || staticAdapterParents.has(context.parentURL)
      ? { ...context, parentURL: sessionReplParent ?? replParent }
      : context)
  },
})
const logScope = new AsyncLocalStorage()
const pending = new Map()
const installedGlobals = new Set()
const PROCESS_CONTROLS = new Set(['exit', 'abort', 'kill', 'chdir'])
const CELL_FRAME_SUFFIX = '\n;'
let filenameSequence = 0
let activeFilename = 'ptc-plus-repl'
const CONFORMANCE_CELL = `"use strict";
{
  if (this !== globalThis) throw new Error('invalid REPL global receiver semantics')
  const __ptc_canary = await Promise.resolve(1)
  if (__ptc_canary !== 1) throw new Error('invalid REPL await semantics')
  const __ptc_import_canary = await import(${JSON.stringify(REPL_IMPORT_CANARY)})
  if (__ptc_import_canary.default !== 1) throw new Error('invalid REPL import semantics')
}`
let activeRun
let activeExecution
let pendingVolatileReason
let nextCallId = 0
let nextStaticAdapterId = 0

class StaticImportFailure {
  constructor(error, position) {
    this.error = error
    this.position = position
  }
}

class CellReturn extends Error {
  constructor(value) {
    super('cell returned')
    this.value = value
  }
}
function appendLog(...values) {
  const current = logScope.getStore()
  if (current?.open !== true) return
  appendText(current, formatWithOptions({ colors: false, depth: 4, maxArrayLength: 100, maxStringLength: 10_000 }, ...values))
}

function appendText(current, text) {
  if (current.open !== true || current.outputLimited) return
  const bytes = Buffer.byteLength(JSON.stringify(text), 'utf8') + (current.logs.length === 0 ? 0 : 1)
  if (current.logBytes + bytes > current.maxOutputBytes) {
    current.outputLimited = true
    channel.postMessage({ type: 'output-limit', id: current.id, logs: current.logs })
    return
  }
  current.logBytes += bytes
  current.logs.push(text)
}

const consoleView = Object.freeze({
  log: appendLog,
  info: appendLog,
  warn: appendLog,
  error: appendLog,
  debug: appendLog,
  dir: value => appendLog(value),
})
Object.defineProperty(context, 'console', { configurable: true, value: consoleView })

function captureWrite(chunk, ...rest) {
  const current = logScope.getStore()
  if (current?.open === true) appendText(current, typeof chunk === 'string' ? chunk : String(chunk))
  const callback = [rest[0], rest[1]].find(value => typeof value === 'function')
  if (callback !== undefined) queueMicrotask(() => callback(null))
  return true
}
process.stdout.write = captureWrite
process.stderr.write = captureWrite

function markVolatile(reason) {
  const current = activeExecution
  if (current === undefined) {
    pendingVolatileReason ??= reason
    return
  }
  if (current.durability === 'volatile') return
  current.durability = 'volatile'
  current.volatileReason ??= reason
  channel.postMessage({ type: 'volatile', id: current.id, reason: current.volatileReason })
}

function completionDurability(execution) {
  return {
    durability: execution.durability,
    ...(execution.volatileReason === undefined ? {} : { volatileReason: execution.volatileReason }),
  }
}

const originalRequire = context.require
const sessionCwdBufferPrefix = sessionCwd === undefined
  ? undefined
  : Buffer.from(sessionCwd + (/[\\/]$/.test(sessionCwd) ? '' : sep))

function virtualizeProcessCwd() {
  if (sessionCwd === undefined) return
  process.cwd = () => sessionCwd
}

function guardProcessControls() {
  for (const property of PROCESS_CONTROLS) {
    const descriptor = Object.getOwnPropertyDescriptor(process, property)
    Object.defineProperty(process, property, {
      configurable: false,
      enumerable: descriptor?.enumerable ?? true,
      writable: false,
      value: () => {
        throw new Error(`process.${property} is forbidden inside the REPL kernel`)
      },
    })
  }
}

function isAbsoluteBufferPath(value) {
  return isAbsolute(String.fromCharCode(...value.subarray(0, 3)))
}

function sessionPath(value) {
  if (sessionCwd === undefined) return value
  if (typeof value === 'string') return isAbsolute(value) ? value : nativeResolve(sessionCwd, value)
  if (Buffer.isBuffer(value)) return isAbsoluteBufferPath(value)
    ? value
    : Buffer.concat([sessionCwdBufferPrefix, value])
  return value
}

function sessionPathPrefix(value) {
  // Node appends the random suffix directly, so terminal prefix text must survive anchoring.
  if (sessionCwd === undefined || typeof value !== 'string' || isAbsolute(value)) {
    return sessionPath(value)
  }
  if (parse(value).root !== '') return sessionPath(value)
  return sessionCwd + (/[\\/]$/.test(sessionCwd) ? '' : sep) + value
}

function wrapBuiltinCallable(original, projectArguments, projectedProperties = []) {
  const wrapped = {
    invoke(...args) {
      return Reflect.apply(original, this, projectArguments(args))
    },
  }.invoke
  const descriptors = Object.getOwnPropertyDescriptors(original)
  const projected = new Set(projectedProperties)
  for (const property of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[property]
    if (descriptor.value === original) {
      descriptors[property] = { ...descriptor, value: wrapped }
    } else if (projected.has(property)) {
      descriptors[property] = {
        ...descriptor,
        value: wrapBuiltinCallable(descriptor.value, projectArguments),
      }
    }
  }
  return Object.defineProperties(wrapped, descriptors)
}

function wrapBuiltin(owner, name, projectArguments, projectedProperties) {
  const original = owner?.[name]
  if (typeof original !== 'function') return
  owner[name] = wrapBuiltinCallable(original, projectArguments, projectedProperties)
}

function fileSystemArguments(args, pathArguments) {
  const next = [...args]
  for (const index of pathArguments) next[index] = sessionPath(next[index])
  return next
}

function fileSystemPrefixArguments(args) {
  const next = [...args]
  next[0] = sessionPathPrefix(next[0])
  return next
}

const FILE_SYSTEM_PATH_ARGUMENTS = Object.freeze({
  access: [0], accessSync: [0], appendFile: [0], appendFileSync: [0],
  chmod: [0], chmodSync: [0], chown: [0], chownSync: [0],
  copyFile: [0, 1], copyFileSync: [0, 1], cp: [0, 1], cpSync: [0, 1],
  createReadStream: [0], createWriteStream: [0], exists: [0], existsSync: [0],
  lchmod: [0], lchmodSync: [0], lchown: [0], lchownSync: [0],
  link: [0, 1], linkSync: [0, 1], lstat: [0], lstatSync: [0],
  lutimes: [0], lutimesSync: [0], mkdir: [0], mkdirSync: [0],
  open: [0], openAsBlob: [0], openSync: [0], opendir: [0], opendirSync: [0],
  readFile: [0], readFileSync: [0], readdir: [0], readdirSync: [0],
  readlink: [0], readlinkSync: [0], realpath: [0], realpathSync: [0],
  rename: [0, 1], renameSync: [0, 1], rm: [0], rmSync: [0],
  rmdir: [0], rmdirSync: [0], stat: [0], statSync: [0], statfs: [0], statfsSync: [0],
  symlink: [1], symlinkSync: [1], truncate: [0], truncateSync: [0],
  unlink: [0], unlinkSync: [0], utimes: [0], utimesSync: [0],
  watch: [0], watchFile: [0], writeFile: [0], writeFileSync: [0],
})
const FILE_SYSTEM_PREFIX_ARGUMENTS = Object.freeze([
  'mkdtemp', 'mkdtempSync', 'mkdtempDisposable', 'mkdtempDisposableSync',
])
const FILE_SYSTEM_PROJECTED_PROPERTIES = Object.freeze({
  exists: [promisify.custom],
  realpath: ['native'],
  realpathSync: ['native'],
})
const CHILD_PROCESS_PROJECTED_PROPERTIES = Object.freeze({
  exec: [promisify.custom],
  execFile: [promisify.custom],
})

function sessionChildOptions(options) {
  if (sessionCwd === undefined || options === null || typeof options !== 'object') return options
  return options.cwd === undefined ? { ...options, cwd: sessionCwd } : options
}

function withDefaultOptions(args, index) {
  const next = [...args]
  next[index] = sessionChildOptions(next[index]) ?? { cwd: sessionCwd }
  return next
}

function childProcessOptions(name, args) {
  if (sessionCwd === undefined) return args
  if (name === 'exec' || name === 'execSync') {
    const next = [...args]
    if (typeof next[1] === 'function') next.splice(1, 0, { cwd: sessionCwd })
    else next[1] = sessionChildOptions(next[1]) ?? { cwd: sessionCwd }
    return next
  }
  if (name === 'execFile' || name === 'execFileSync') {
    if (args.length === 1 || typeof args[1] === 'function') {
      const next = [...args]
      next.splice(1, 0, { cwd: sessionCwd })
      return next
    }
    if (typeof args[2] === 'function') {
      if (args[1] !== undefined && !Array.isArray(args[1])) return withDefaultOptions(args, 1)
      const next = [...args]
      next.splice(2, 0, { cwd: sessionCwd })
      return next
    }
    if (args[1] !== undefined && !Array.isArray(args[1])) return withDefaultOptions(args, 1)
    return withDefaultOptions(args, 2)
  }
  if (args.length === 1 || (args[1] !== undefined && !Array.isArray(args[1]))) {
    return withDefaultOptions(args, 1)
  }
  return withDefaultOptions(args, 2)
}

function virtualizeChildProcessCwd(childProcess) {
  if (sessionCwd === undefined) return
  for (const name of ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']) {
    wrapBuiltin(
      childProcess,
      name,
      args => childProcessOptions(name, args),
      CHILD_PROCESS_PROJECTED_PROPERTIES[name],
    )
  }
}

function sessionGlobOptions(args) {
  const next = [...args]
  if (typeof next[1] === 'function') {
    next.splice(1, 0, { cwd: sessionCwd })
  } else if (next[1] === undefined) {
    next[1] = { cwd: sessionCwd }
  } else if (next[1] !== null && typeof next[1] === 'object' && next[1].cwd === undefined) {
    next[1] = { ...next[1], cwd: sessionCwd }
  }
  return next
}

function virtualizeGlobCwd(owner, name) {
  wrapBuiltin(owner, name, sessionGlobOptions)
}

function virtualizeFileSystemPaths() {
  if (sessionCwd === undefined) return
  virtualizeProcessCwd()
  const fs = originalRequire('node:fs')
  const path = originalRequire('node:path')
  for (const [name, pathArguments] of Object.entries(FILE_SYSTEM_PATH_ARGUMENTS)) {
    wrapBuiltin(
      fs,
      name,
      args => fileSystemArguments(args, pathArguments),
      FILE_SYSTEM_PROJECTED_PROPERTIES[name],
    )
    wrapBuiltin(fs.promises, name, args => fileSystemArguments(args, pathArguments))
  }
  for (const name of FILE_SYSTEM_PREFIX_ARGUMENTS) {
    wrapBuiltin(fs, name, fileSystemPrefixArguments)
    wrapBuiltin(fs.promises, name, fileSystemPrefixArguments)
  }
  for (const name of ['glob', 'globSync']) {
    virtualizeGlobCwd(fs, name)
    virtualizeGlobCwd(fs.promises, name)
  }
  wrapBuiltin(path, 'resolve', args => [sessionCwd, ...args])
  virtualizeChildProcessCwd(originalRequire('node:child_process'))
}
guardProcessControls()
virtualizeFileSystemPaths()
synchronizeBuiltinEsmExports()
const originalGlobals = Object.fromEntries(
  [...AMBIENT_GLOBALS].filter(name => name !== 'require')
    .map(name => [name, globalThis[name]]),
)
Object.defineProperty(context, 'require', {
  configurable: true,
  value(specifier) {
    if (FORBIDDEN_IMPORTS.has(specifier)) throw new Error(`module ${specifier} is forbidden because it exposes kernel control`)
    if (!DURABLE_IMPORTS.has(specifier)) markVolatile(`require(${JSON.stringify(specifier)})`)
    return originalRequire(specifier)
  },
})

for (const [name, value] of Object.entries(originalGlobals)) {
  Object.defineProperty(context, name, {
    configurable: true,
    get() {
      markVolatile(`ambient ${name}`)
      return value
    },
    set(next) {
      markVolatile(`ambient ${name}`)
      Object.defineProperty(context, name, { configurable: true, writable: true, value: next })
    },
  })
}

const capturedOutput = Object.freeze({ write: captureWrite })
const processView = new Proxy(process, {
  get(target, property) {
    if (property === 'stdout' || property === 'stderr') return capturedOutput
    if (property === 'cwd') {
      if (sessionCwd !== undefined) return () => sessionCwd
      markVolatile('process.cwd')
      return target.cwd.bind(target)
    }
    if (PROCESS_CONTROLS.has(property)) return Reflect.get(target, property, target)
    markVolatile(`process.${String(property)}`)
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  },
  set(target, property, value) {
    if (property === 'stdout' || property === 'stderr') return false
    markVolatile(`process.${String(property)}`)
    return Reflect.set(target, property, value, target)
  },
  ownKeys(target) {
    markVolatile('process reflection')
    return Reflect.ownKeys(target)
  },
})
Object.defineProperty(context, 'process', { configurable: true, value: processView })

const mathDescriptors = Object.getOwnPropertyDescriptors(Math)
mathDescriptors.random = {
  ...mathDescriptors.random,
  value: () => {
    markVolatile('Math.random')
    return Math.random()
  },
}
const mathView = Object.defineProperties(Object.create(Object.getPrototypeOf(Math)), mathDescriptors)
Object.defineProperty(context, 'Math', {
  configurable: true,
  value: Object.freeze(mathView),
})

function evaluate(program) {
  return new Promise((resolve, reject) => {
    // REPLServer routes runtime throws to its domain instead of the eval
    // callback. Cells are serialized, so temporarily replacing that one error
    // handler gives both syntax and runtime failures one settlement path.
    const domain = server._domain
    const prior = domain.listeners('error')
    domain.removeAllListeners('error')
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      domain.removeListener('error', onError)
      for (const listener of prior) domain.on('error', listener)
      if (error instanceof CellReturn) {
        Promise.resolve(error.value).then(
          value => resolve({ hasValue: true, value }),
          reject,
        )
      } else if (error) reject(error)
      else {
        Promise.resolve(value).then(
          value => resolve({ hasValue: value !== undefined, value }),
          reject,
        )
      }
    }
    const onError = error => finish(error)
    domain.on('error', onError)
    activeFilename = `ptc-plus-repl-${++filenameSequence}`
    server.eval(program + CELL_FRAME_SUFFIX, context, activeFilename, finish)
  })
}

function staticImportAttributes(options) {
  if (options === undefined) return ''
  const [keyword, attributes] = Object.entries(options)[0]
  const entries = Object.entries(attributes)
    .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
  return ` ${keyword} { ${entries.join(', ')} }`
}

function staticAdapterSource(load) {
  const source = JSON.stringify(load.source)
  const attributes = staticImportAttributes(load.options)
  if (load.global === undefined) return `import ${source}${attributes};`
  const requirements = load.requiredExports?.map((name, index) => {
    const imported = name === 'default' ? 'default' : JSON.stringify(name)
    return `${imported} as __required_${index}__`
  }) ?? []
  return [
    `import * as namespace from ${source}${attributes};`,
    ...(requirements.length === 0 ? [] : [
      `export { ${requirements.join(', ')} } from ${source}${attributes};`,
    ]),
    'export { namespace };',
  ].join('\n')
}

async function loadStaticModule(load) {
  const adapter = `data:text/javascript,${encodeURIComponent(staticAdapterSource(load))}#${++nextStaticAdapterId}`
  staticAdapterParents.add(adapter)
  try {
    const completion = await evaluate(`import(${JSON.stringify(adapter)})`)
    return completion.value.namespace
  } finally {
    staticAdapterParents.delete(adapter)
  }
}

function callHost(runId, global, member, args, errorClass) {
  if (activeRun !== runId) return Promise.reject(new Error('PTC execution lease expired'))
  const id = ++nextCallId
  let settle
  const result = new Promise((resolve, reject) => { settle = { resolve, reject, errorClass, member } })
  void result.catch(() => {})
  pending.set(id, { ...settle, runId })
  try {
    channel.postMessage({
      type: 'call', runId, id, global, member,
      args: encodeValue(args, activeExecution?.valueLimits),
    })
  } catch (error) {
    pending.delete(id)
    settle.reject(error)
  }
  return result
}

function installBindings(message) {
  for (const name of installedGlobals) delete context[name]
  installedGlobals.clear()

  for (const namespace of message.namespaces) {
    const view = Object.create(null)
    for (const member of namespace.members) {
      Object.defineProperty(view, member, {
        enumerable: true,
        value: args => callHost(message.id, namespace.global, member, args, namespace.errorClass),
      })
    }
    Object.freeze(view)
    Object.defineProperty(context, namespace.global, { configurable: true, value: view })
    installedGlobals.add(namespace.global)

    if (namespace.errorClass !== undefined) {
      const descriptor = namespace.errorClass
      const BoundError = class extends Error {
        constructor(member, detail, cause) {
          super(detail)
          this.name = descriptor.name
          Object.defineProperty(this, descriptor.memberNameProperty, { enumerable: true, value: member })
          if (cause !== undefined) Object.defineProperty(this, 'ptcCause', { value: cause })
        }
      }
      Object.defineProperty(context, descriptor.name, { configurable: true, value: BoundError })
      installedGlobals.add(descriptor.name)
    }
  }
}

async function runCell(message) {
  if (activeRun !== undefined) throw new Error('kernel received overlapping cells')
  activeRun = message.id
  installBindings(message)
  const execution = {
    id: message.id,
    logs: [],
    open: true,
    outputLimited: false,
    logBytes: 2,
    maxOutputBytes: message.maxOutputBytes,
    valueLimits: message.valueLimits,
    durability: message.durability === 'volatile' || pendingVolatileReason !== undefined ? 'volatile' : 'durable',
    volatileReason: pendingVolatileReason,
  }
  pendingVolatileReason = undefined
  activeExecution = execution
  const cellGlobals = []

  try {
    let completion
    try {
      completion = await logScope.run(execution, async () => {
        Object.defineProperty(context, message.returnSignal, {
          configurable: true,
          value: CellReturn,
        })
        cellGlobals.push(message.returnSignal)
        for (const load of message.moduleLoads ?? []) {
          let namespace
          try {
            namespace = await loadStaticModule(load)
          } catch (error) {
            throw new StaticImportFailure(error, load.position)
          }
          if (load.global !== undefined) {
            Object.defineProperty(context, load.global, {
              configurable: true,
              value: namespace,
            })
            cellGlobals.push(load.global)
          }
        }
        return evaluate(message.program)
      })
      activeRun = undefined
      execution.open = false
      const calls = [...pending.values()]
        .filter(call => call.runId === message.id)
        .map(call => new Promise(resolve => {
          const originalResolve = call.resolve
          const originalReject = call.reject
          call.resolve = value => { originalResolve(value); resolve() }
          call.reject = error => { originalReject(error); resolve() }
        }))
      if (calls.length > 0) await Promise.all(calls)
    } catch (error) {
      activeRun = undefined
      execution.open = false
      const failure = error instanceof StaticImportFailure ? error.error : error
      const detail = errorDetails(failure, activeFilename)
      const position = error instanceof StaticImportFailure ? error.position : detail.position
      channel.postMessage({
        type: 'done',
        id: message.id,
        logs: execution.logs,
        error: detail.message,
        errorName: detail.name,
        ...(error instanceof StaticImportFailure ? { moduleLoadFailed: true } : {}),
        ...(position === undefined ? {} : { position }),
        ...(detail.cause === undefined ? {} : { cause: detail.cause }),
        ...completionDurability(execution),
      })
      return
    }

    let response
    try {
      const encodedValue = completion.hasValue
        ? encodeValue(completion.value, execution.valueLimits)
        : undefined
      response = {
        type: 'done',
        id: message.id,
        logs: execution.logs,
        hasValue: completion.hasValue,
        ...(encodedValue === undefined ? {} : { value: encodedValue }),
        ...completionDurability(execution),
      }
    } catch (error) {
      const detail = messageOf(error)
      response = {
        type: 'done',
        id: message.id,
        logs: execution.logs,
        invalidOutput: detail,
        ...completionDurability(execution),
      }
    }
    channel.postMessage(response)
  } finally {
    for (const name of cellGlobals) delete context[name]
    activeRun = undefined
    activeExecution = undefined
    execution.open = false
  }
}

channel.on('message', (message) => {
  if (message?.type === 'reply') {
    const call = pending.get(message.id)
    if (call === undefined || call.runId !== message.runId) return
    pending.delete(message.id)
    if (message.ok) call.resolve(decodeValue(message.value, activeExecution?.valueLimits))
    else if (call.errorClass === undefined) {
      const error = new Error(message.error)
      if (message.cause !== undefined) error.ptcCause = message.cause
      call.reject(error)
    } else call.reject(new context[call.errorClass.name](call.member, message.error, message.cause))
    return
  }
  if (message?.type === 'run') void runCell(message)
})

try {
  await evaluate(CONFORMANCE_CELL)
  parentPort.postMessage({ type: 'ready', port: port1 }, [port1])
} catch (error) {
  parentPort.postMessage({
    type: 'startup-error',
    error: `Node REPL does not satisfy the PTC Plus cell framing contract: ${messageOf(error)}`,
  })
}
