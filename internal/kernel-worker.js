import { AsyncLocalStorage } from 'node:async_hooks'
import repl from 'node:repl'
import { PassThrough } from 'node:stream'
import { formatWithOptions } from 'node:util'
import { MessageChannel, parentPort } from 'node:worker_threads'
import { decodeJson, encodeJson } from './json-wire.js'

if (parentPort === null) throw new Error('ptc-plus kernel worker started without a parent port')
const { port1, port2: channel } = new MessageChannel()
parentPort.postMessage({ type: 'ready', port: port1 }, [port1])

const input = new PassThrough()
const output = new PassThrough()
output.resume()
const server = repl.start({
  input,
  output,
  terminal: false,
  prompt: '',
  useGlobal: false,
  ignoreUndefined: true,
})
const context = server.context
const logScope = new AsyncLocalStorage()
const pending = new Map()
const installedGlobals = new Set()
const RETURN_SIGNAL = '__dsh_ptc_return_signal_7f3a__'
let activeRun
let activeExecution
let pendingVolatileReason
let nextCallId = 0

class CellReturn extends Error {
  constructor(value) {
    super('cell returned')
    this.value = value
  }
}
Object.defineProperty(context, RETURN_SIGNAL, { value: CellReturn })

function messageOf(error) {
  try {
    return String(error instanceof Error ? error.stack ?? error.message : error)
  } catch {
    return 'Unprintable thrown value'
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
}

function completionDurability(execution) {
  return {
    durability: execution.durability,
    ...(execution.volatileReason === undefined ? {} : { volatileReason: execution.volatileReason }),
  }
}

const originalRequire = context.require
const originalGlobals = Object.fromEntries(
  ['Date', 'performance', 'fetch', 'WebSocket', 'crypto', 'Intl', 'setTimeout', 'setInterval', 'setImmediate', 'eval', 'Function']
    .map(name => [name, globalThis[name]]),
)
const forbiddenModules = new Set(['node:worker_threads', 'worker_threads', 'node:cluster', 'cluster'])
Object.defineProperty(context, 'require', {
  configurable: true,
  value(specifier) {
    if (forbiddenModules.has(specifier)) throw new Error(`module ${specifier} is forbidden because it exposes kernel control`)
    markVolatile(`require(${JSON.stringify(specifier)})`)
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
    if (['exit', 'abort', 'kill'].includes(property)) {
      return () => { throw new Error(`process.${String(property)} is forbidden inside the REPL kernel`) }
    }
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
      if (error instanceof CellReturn) resolve(error.value)
      else if (error) reject(error)
      else resolve(value)
    }
    const onError = error => finish(error)
    domain.on('error', onError)
    server.eval(program, context, 'ptc-plus-repl', finish)
  })
}

function callHost(runId, global, member, args, errorClass) {
  if (activeRun !== runId) return Promise.reject(new Error('PTC execution lease expired'))
  const id = ++nextCallId
  let settle
  const result = new Promise((resolve, reject) => { settle = { resolve, reject, errorClass, member } })
  void result.catch(() => {})
  pending.set(id, { ...settle, runId })
  try {
    channel.postMessage({ type: 'call', runId, id, global, member, args: encodeJson(args) })
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
        constructor(member, detail) {
          super(detail)
          this.name = descriptor.name
          Object.defineProperty(this, descriptor.memberNameProperty, { enumerable: true, value: member })
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
    durability: message.durability === 'volatile' || pendingVolatileReason !== undefined ? 'volatile' : 'durable',
    volatileReason: pendingVolatileReason,
  }
  pendingVolatileReason = undefined
  activeExecution = execution

  try {
    let value
    try {
      value = await logScope.run(execution, () => evaluate(message.program))
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
      const detail = messageOf(error)
      channel.postMessage({
        type: 'done',
        id: message.id,
        logs: execution.logs,
        error: detail,
        ...completionDurability(execution),
      })
      return
    }

    let response
    try {
      const encodedValue = value === undefined ? undefined : encodeJson(value)
      response = {
        type: 'done',
        id: message.id,
        logs: execution.logs,
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
    if (message.ok) call.resolve(decodeJson(message.value))
    else if (call.errorClass === undefined) call.reject(new Error(message.error))
    else call.reject(new context[call.errorClass.name](call.member, message.error))
    return
  }
  if (message?.type === 'run') void runCell(message)
})
