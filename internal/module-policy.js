export const DURABLE_IMPORTS = new Set([
  'node:assert',
  'node:buffer',
  'node:querystring',
  'node:string_decoder',
  'node:stream',
  'node:util',
  'node:url',
  'node:zlib',
])

export const AMBIENT_GLOBALS = new Set([
  'Date', 'performance', 'fetch', 'WebSocket', 'crypto', 'Intl',
  'setTimeout', 'setInterval', 'setImmediate', 'eval', 'Function', 'require',
])

export const FORBIDDEN_IMPORTS = new Set([
  'node:worker_threads', 'worker_threads', 'node:cluster', 'cluster',
])

export const DYNAMIC_MODULE_REASON = Object.freeze({ kind: 'dynamic-module-resolution' })

export function classifyModuleSource(source) {
  if (FORBIDDEN_IMPORTS.has(source)) {
    return Object.freeze({ status: 'forbidden', source })
  }
  if (DURABLE_IMPORTS.has(source)) return Object.freeze({ status: 'durable', source })
  return Object.freeze({
    status: 'volatile',
    source,
    reason: Object.freeze({ kind: 'module', source }),
  })
}

export function renderDurabilityReason(reason) {
  if (reason.kind === 'module') return `module ${reason.source}`
  if (reason.kind === 'dynamic-module-resolution') return 'dynamic module resolution'
  if (reason.kind === 'ambient') return `ambient ${reason.name}`
  if (reason.kind === 'math-random') return 'Math.random'
  if (reason.kind === 'computed-global-access') return 'computed global access'
  throw new TypeError(`unknown durability reason ${JSON.stringify(reason?.kind)}`)
}

export function renderDurabilityReasons(reasons) {
  return reasons.map(renderDurabilityReason).join(', ')
}
