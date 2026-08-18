import { stripTypeScriptTypes } from 'node:module'
import { Worker } from 'node:worker_threads'
import { parse } from 'acorn'
import { decodeJson, encodeJson } from './json-wire.js'
import { diagnostic, renderDiagnostic } from './diagnostic.js'
import { assertStateName, createJournal, normalizeJournal, pathToHead, recoverJournal } from './session-journal.js'

const WORKER_URL = new URL('./kernel-worker.js', import.meta.url)
const STRIP_PREFIX = 'async function __ptc_cell__(){\n'
const STRIP_SUFFIX = '\n}'
const RETURN_SIGNAL = '__dsh_ptc_return_signal_7f3a__'
const DEFAULTS = Object.freeze({
  computeMs: 60_000,
  maxWallMs: 600_000,
  maxOutputBytes: 64 * 1024 * 1024,
  maxOldGenerationSizeMb: 512,
})
const MAX_TIMER_DELAY_MS = 2_147_483_647
const DURABLE_IMPORTS = new Set([
  'node:assert',
  'node:buffer',
  'node:querystring',
  'node:string_decoder',
  'node:stream',
  'node:util',
  'node:url',
  'node:zlib',
])
const AMBIENT_GLOBALS = new Set([
  'Date', 'performance', 'fetch', 'WebSocket', 'crypto', 'Intl',
  'setTimeout', 'setInterval', 'setImmediate', 'eval', 'Function', 'require',
])
const FORBIDDEN_IMPORTS = new Set(['node:worker_threads', 'worker_threads', 'node:cluster', 'cluster'])

class PreflightError extends Error {
  constructor(message, node) {
    super(message)
    this.span = declarationSpan(node)
  }
}

function safeProperty(value, key) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined
  try {
    return value[key]
  } catch {
    return undefined
  }
}

function messageOf(error) {
  const message = safeProperty(error, 'message')
  if (typeof message === 'string') return message
  try {
    return String(error)
  } catch {
    return 'Unprintable error'
  }
}

function firstLine(value, fallback) {
  if (typeof value !== 'string') return fallback
  const line = value.split(/[\r\n]/, 1)[0]
  return line.length > 0 ? line : fallback
}

function oneLineMessage(error) {
  return firstLine(messageOf(error), 'Unknown error').replace(/\s+\(\d+:\d+\)$/, '')
}

function hostCause(error) {
  const candidate = safeProperty(error, 'diagnostic') ?? safeProperty(error, 'cause') ?? error
  const candidateMessage = safeProperty(candidate, 'message')
  const message = firstLine(candidateMessage, oneLineMessage(error))
  const candidateCode = safeProperty(candidate, 'code')
  const errorCode = safeProperty(error, 'code')
  const code = firstLine(candidateCode, firstLine(errorCode, undefined))
  return { ...(code === undefined ? {} : { code }), message }
}

function volatileDiagnostic(reason, succeeded = true) {
  const reasonLine = firstLine(reason, '')
  const detail = reasonLine.length > 0 ? ` (${reasonLine})` : ''
  const continuity = succeeded
    ? 'Cell completed successfully and the REPL remains available in this process'
    : 'The REPL remains available in this process; bindings and mutations completed before the failure can still be reused'
  return diagnostic({
    code: 'PTC-V001',
    severity: 'warning',
    phase: 'execute',
    message: `${continuity}; PTC Plus status: volatile${detail}. Existing and new live bindings can be reused, but this cell and later cells are not replayed after restart until the durable head is restored.`,
    stateEffect: 'unknown',
    help: [
      'continue using the existing live bindings',
      'use repl.state({ action: "list" }) to inspect the current mode',
      'restore the durable head only when you need to discard the volatile suffix',
    ],
  })
}

function recoveryDiagnostic(count) {
  return diagnostic({
    code: 'PTC-R002',
    severity: 'warning',
    phase: 'recover',
    message: `Restored the durable head and skipped ${count} volatile or unconfirmed cell(s) from history; their source remains in the session log.`,
    stateEffect: 'rolled-back',
    help: [
      'continue from the restored bindings',
      'do not reference values created only in the skipped suffix',
    ],
  })
}

function parseDiagnostic(error, source) {
  const sourceLines = typeof source === 'string' ? source.split(/\r?\n/) : []
  let line = Number.isSafeInteger(error?.loc?.line) ? error.loc.line - 1 : undefined
  let column = Number.isSafeInteger(error?.loc?.column) ? error.loc.column + 1 : undefined
  if (line !== undefined && line > sourceLines.length && sourceLines.length > 0) {
    line = sourceLines.length
    column = sourceLines[sourceLines.length - 1].length + 1
  }
  return diagnostic({
    code: 'PTC-C001',
    severity: 'error',
    phase: 'parse',
    message: `cell could not be parsed: ${oneLineMessage(error)}`,
    stateEffect: 'unchanged',
    ...(line !== undefined && line >= 1 && column !== undefined ? {
      source: { cell: 'current', start: { line, column } },
    } : {}),
    help: ['repair the reported syntax and retry only this cell'],
  })
}

function preflightDiagnostic(error) {
  return diagnostic({
    code: 'PTC-C002',
    severity: 'error',
    phase: 'preflight',
    message: oneLineMessage(error),
    stateEffect: 'unchanged',
    ...(error.span === undefined ? {} : {
      source: {
        cell: 'current',
        start: { line: error.span.line, column: error.span.column },
        ...(error.span.end === undefined ? {} : { end: error.span.end }),
      },
    }),
    help: ['remove the kernel-control import and use the provided REPL or tools bindings'],
  })
}

function collisionDiagnostic(collisions) {
  const names = [...new Set(collisions.map(item => item.name))]
  const first = collisions[0]
  return diagnostic({
    code: 'PTC-N001',
    severity: 'error',
    phase: 'preflight',
    message: `top-level bindings already exist: ${names.join(', ')}. This cell was not executed; the REPL state is unchanged.`,
    stateEffect: 'unchanged',
    source: { cell: 'current', start: first.start, end: first.end },
    help: [
      'reuse the existing bindings',
      'place one-off declarations inside a block',
    ],
  })
}

function exceptionDiagnostic(error, cause = undefined) {
  const message = firstLine(error.message, 'Unknown exception')
  const rawName = typeof error.name === 'string' && error.name.length > 0
    ? error.name
    : typeof error.kind === 'string' && error.kind.length > 0 ? error.kind : 'Error'
  const name = firstLine(rawName, 'Error')
  return diagnostic({
    code: 'PTC-X001',
    severity: 'error',
    phase: 'execute',
    message: `uncaught ${name}: ${message}`,
    stateEffect: 'partially-applied',
    ...(cause === undefined ? {} : { cause }),
    help: ['inspect existing bindings and retry only the failing expression'],
  })
}

/** Compare two lossless JSON trees without recursive stack growth. */
function sameJson(left, right) {
  const pending = [[left, right]]
  while (pending.length > 0) {
    const pair = pending.pop()
    const a = pair[0]
    const b = pair[1]
    if (a === b) continue
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
    const aArray = Array.isArray(a)
    if (aArray !== Array.isArray(b)) return false
    if (aArray) {
      if (a.length !== b.length) return false
      for (let index = 0; index < a.length; index++) pending.push([a[index], b[index]])
      continue
    }
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    for (let index = 0; index < aKeys.length; index++) {
      const key = aKeys[index]
      if (key !== bKeys[index] || !Object.hasOwn(b, key)) return false
      pending.push([a[key], b[key]])
    }
  }
  return true
}

function stateArguments(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('repl.state expects an object')
  }
  const action = value.action
  if (!['list', 'save', 'restore', 'delete'].includes(action)) {
    throw new TypeError('repl.state action must be list, save, restore, or delete')
  }
  if (action === 'save' || action === 'delete' || (action === 'restore' && value.name !== undefined)) {
    assertStateName(value.name)
  }
  return { action, ...(value.name === undefined ? {} : { name: value.name }) }
}

function addPatternBindings(pattern, names) {
  if (pattern === null || typeof pattern !== 'object') return
  if (pattern.type === 'Identifier') {
    names.add(pattern.name)
    return
  }
  if (pattern.type === 'RestElement') return addPatternBindings(pattern.argument, names)
  if (pattern.type === 'AssignmentPattern') return addPatternBindings(pattern.left, names)
  if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) addPatternBindings(element, names)
    return
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      addPatternBindings(property.type === 'RestElement' ? property.argument : property.value, names)
    }
  }
}

function topLevelBindings(body) {
  return new Set(topLevelDeclarations(body).map(declaration => declaration.name))
}

function declarationSpan(node) {
  const start = node.loc?.start
  const end = node.loc?.end ?? start
  if (start === undefined) return undefined
  return {
    line: Math.max(1, start.line - 1),
    column: start.column + 1,
    ...(end === undefined ? {} : {
      end: {
        line: Math.max(1, end.line - 1),
        column: end.column + 1,
      },
    }),
  }
}

function addPatternDeclarations(pattern, declarations) {
  if (pattern === null || typeof pattern !== 'object') return
  if (pattern.type === 'Identifier') {
    declarations.push({ name: pattern.name, span: declarationSpan(pattern) })
    return
  }
  if (pattern.type === 'RestElement') return addPatternDeclarations(pattern.argument, declarations)
  if (pattern.type === 'AssignmentPattern') return addPatternDeclarations(pattern.left, declarations)
  if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) addPatternDeclarations(element, declarations)
    return
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      addPatternDeclarations(property.type === 'RestElement' ? property.argument : property.value, declarations)
    }
  }
}

function topLevelDeclarations(body) {
  const declarations = []
  for (const statement of body) {
    if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations) addPatternDeclarations(declaration.id, declarations)
    } else if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration')
      && statement.id !== null) {
      declarations.push({ name: statement.id.name, span: declarationSpan(statement.id) })
    }
  }
  return declarations
}

function directBlockBindings(body) {
  const names = new Set()
  for (const statement of body) {
    if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      for (const declaration of statement.declarations) addPatternBindings(declaration.id, names)
    } else if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration')
      && statement.id !== null) {
      names.add(statement.id.name)
    }
  }
  return names
}

function functionBindings(node) {
  const names = new Set()
  if (node.id !== null && node.id !== undefined) names.add(node.id.name)
  for (const param of node.params ?? []) addPatternBindings(param, names)
  const visit = (current) => {
    if (current === null || typeof current !== 'object') return
    if (current !== node && isFunction(current)) {
      if (current.type === 'FunctionDeclaration' && current.id !== null) names.add(current.id.name)
      return
    }
    if (current.type === 'VariableDeclaration' && current.kind === 'var') {
      for (const declaration of current.declarations) addPatternBindings(declaration.id, names)
    }
    for (const [key, value] of Object.entries(current)) {
      if (key === 'start' || key === 'end' || key === 'loc') continue
      if (Array.isArray(value)) value.forEach(visit)
      else visit(value)
    }
  }
  visit(node.body)
  return names
}

function loopBindings(node) {
  const declaration = node.type === 'ForStatement' ? node.init : node.left
  if (declaration?.type !== 'VariableDeclaration' || declaration.kind === 'var') return new Set()
  const names = new Set()
  for (const entry of declaration.declarations) addPatternBindings(entry.id, names)
  return names
}

function isReferenceIdentifier(node, parent, key) {
  if (parent === undefined) return false
  if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression')
    && key === 'property' && !parent.computed) return false
  if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition')
    && key === 'key' && !parent.computed && !parent.shorthand) return false
  if (['VariableDeclarator', 'FunctionDeclaration', 'FunctionExpression', 'ClassDeclaration', 'ClassExpression']
    .includes(parent.type) && key === 'id') return false
  if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ArrowFunctionExpression')
    && key === 'params') return false
  if (parent.type === 'CatchClause' && key === 'param') return false
  if (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent.type) && key === 'label') return false
  return true
}

function isStableProcessMember(node, parent) {
  if (node.name !== 'process' || parent?.type !== 'MemberExpression' || parent.object !== node) return false
  const member = parent.computed
    ? parent.property?.type === 'Literal' ? parent.property.value : undefined
    : parent.property?.type === 'Identifier' ? parent.property.name : undefined
  return ['stdout', 'stderr', 'cwd'].includes(member)
}

/** Conservatively classify a cell before giving it non-journalable capability. */
function classifyDurability(code, knownBindings = new Set()) {
  const tree = parse(`${STRIP_PREFIX}${code}${STRIP_SUFFIX}`, { ecmaVersion: 'latest', sourceType: 'script', locations: true })
  const outer = tree.body[0]
  if (outer?.type !== 'FunctionDeclaration') throw new Error('ptc-plus: failed to parse cell wrapper')
  const declared = topLevelBindings(outer.body.body)
  const rootBindings = new Set([...knownBindings, ...declared])
  const reasons = new Set()
  const isBound = (name, scopes) => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      if (scopes[index].has(name)) return true
    }
    return false
  }
  const walk = (node, parent, parentKey, scopes) => {
    if (node === null || typeof node !== 'object') return
    let nestedScopes = scopes
    if (isFunction(node)) {
      nestedScopes = [...scopes, functionBindings(node)]
    } else if (node.type === 'BlockStatement' && node !== outer.body) {
      nestedScopes = [...scopes, directBlockBindings(node.body)]
    } else if (node.type === 'CatchClause') {
      const names = new Set()
      addPatternBindings(node.param, names)
      nestedScopes = [...scopes, names]
    } else if (['ForStatement', 'ForInStatement', 'ForOfStatement'].includes(node.type)) {
      nestedScopes = [...scopes, loopBindings(node)]
    }
    if (node.type === 'ImportExpression') {
      const source = node.source
      if (source?.type !== 'Literal' || typeof source.value !== 'string') {
        reasons.add('dynamic module resolution')
      } else if (FORBIDDEN_IMPORTS.has(source.value)) {
        throw new PreflightError(`cell import of ${source.value} is forbidden because it exposes kernel control`, source)
      } else if (!DURABLE_IMPORTS.has(source.value)) {
        reasons.add(`module ${source.value}`)
      }
    }
    if (node.type === 'Identifier' && isReferenceIdentifier(node, parent, parentKey)
      && !isBound(node.name, nestedScopes) && AMBIENT_GLOBALS.has(node.name)) {
      reasons.add(`ambient ${node.name}`)
    }
    if (node.type === 'Identifier' && isReferenceIdentifier(node, parent, parentKey)
      && !isBound('process', nestedScopes) && node.name === 'process' && !isStableProcessMember(node, parent)) {
      reasons.add('ambient process')
    }
    if (node.type === 'MemberExpression' && node.object?.type === 'Identifier' && node.object.name === 'Math'
      && !isBound('Math', nestedScopes) && ((!node.computed && node.property?.name === 'random')
        || (node.computed && node.property?.type === 'Literal' && node.property.value === 'random'))) {
      reasons.add('Math.random')
    }
    if (node.type === 'MemberExpression' && node.object?.type === 'Identifier'
      && node.object.name === 'globalThis' && node.computed) {
      reasons.add('computed global access')
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'loc') continue
      if (Array.isArray(value)) value.forEach(child => walk(child, node, key, nestedScopes))
      else walk(value, node, key, nestedScopes)
    }
  }
  walk(outer.body, outer, 'body', [rootBindings])
  return {
    durability: reasons.size === 0 ? 'durable' : 'volatile',
    reason: [...reasons].join(', '),
    declared,
  }
}

function resolveConfig(config) {
  const resolved = { ...DEFAULTS, ...config }
  for (const key of ['computeMs', 'maxWallMs', 'maxOutputBytes', 'maxOldGenerationSizeMb']) {
    const value = resolved[key]
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`ptc-plus: ${key} must be a positive safe integer`)
    }
  }
  if (resolved.maxWallMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`ptc-plus: maxWallMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  return resolved
}

function isFunction(node) {
  return node.type === 'FunctionDeclaration'
    || node.type === 'FunctionExpression'
    || node.type === 'ArrowFunctionExpression'
}

function rewriteCellReturns(code) {
  const wrapped = STRIP_PREFIX + code + STRIP_SUFFIX
  const tree = parse(wrapped, { ecmaVersion: 'latest', sourceType: 'script' })
  const outer = tree.body[0]
  if (outer?.type !== 'FunctionDeclaration') throw new Error('ptc-plus: failed to parse cell wrapper')
  const offset = STRIP_PREFIX.length
  const edits = []
  const signal = `globalThis[${JSON.stringify(RETURN_SIGNAL)}]`
  let catchSequence = 0

  const visit = (node, root = false) => {
    if (node === null || typeof node !== 'object') return
    if (!root && isFunction(node)) return
    if (node.type === 'ReturnStatement') {
      const start = node.start - offset
      const end = node.end - offset
      const argument = node.argument === null
        ? ''
        : code.slice(node.argument.start - offset, node.argument.end - offset)
      edits.push({ start, end, text: `throw new ${signal}(${argument})` })
      return
    }
    if (node.type === 'CatchClause') {
      const bodyStart = node.body.start - offset + 1
      const temporary = `__dsh_ptc_caught_${catchSequence++}__`
      if (node.param === null) {
        edits.push({ start: node.start - offset + 5, end: node.start - offset + 5, text: ` (${temporary})` })
        edits.push({ start: bodyStart, end: bodyStart, text: `\nif (${temporary} instanceof ${signal}) throw ${temporary};` })
      } else if (node.param.type === 'Identifier') {
        edits.push({
          start: bodyStart,
          end: bodyStart,
          text: `\nif (${node.param.name} instanceof ${signal}) throw ${node.param.name};`,
        })
      } else {
        const pattern = code.slice(node.param.start - offset, node.param.end - offset)
        edits.push({ start: node.param.start - offset, end: node.param.end - offset, text: temporary })
        edits.push({
          start: bodyStart,
          end: bodyStart,
          text: `\nif (${temporary} instanceof ${signal}) throw ${temporary};\nconst ${pattern} = ${temporary};`,
        })
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue
      if (Array.isArray(value)) {
        for (const child of value) visit(child)
      } else visit(value)
    }
  }
  visit(outer.body, true)

  edits.sort((left, right) => right.start - left.start || right.end - left.end)
  let rewritten = code
  for (const edit of edits) {
    rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end)
  }
  return rewritten
}

function prepareProgram(program, knownBindings) {
  if (typeof program !== 'string') throw new TypeError('ptc-plus: program must be a string')
  const wrapped = STRIP_PREFIX + program + STRIP_SUFFIX
  let stripped
  try {
    stripped = stripTypeScriptTypes(wrapped)
  } catch (stripError) {
    try {
      parse(wrapped, { ecmaVersion: 'latest', sourceType: 'script', locations: true })
    } catch (parseError) {
      throw parseError
    }
    throw stripError
  }
  const code = stripped.slice(STRIP_PREFIX.length, stripped.length - STRIP_SUFFIX.length)
  const tree = parse(stripped, { ecmaVersion: 'latest', sourceType: 'script', locations: true })
  const outer = tree.body[0]
  const declarations = outer?.type === 'FunctionDeclaration' ? topLevelDeclarations(outer.body.body) : []
  const collisions = declarations
    .filter(declaration => knownBindings.has(declaration.name))
    .map(declaration => ({
      name: declaration.name,
      start: declaration.span === undefined ? { line: 1, column: 1 } : {
        line: declaration.span.line,
        column: declaration.span.column,
      },
      ...(declaration.span?.end === undefined ? {} : { end: declaration.span.end }),
    }))
  const classification = classifyDurability(code, knownBindings)
  return {
    code: collisions.length === 0 ? rewriteCellReturns(code) : code,
    ...classification,
    collisions,
  }
}

function describeBindings(bindings) {
  if (!Array.isArray(bindings)) throw new TypeError('ptc-plus: bindings must be an array')
  return bindings.map((namespace) => {
    if (namespace === null || typeof namespace !== 'object' || typeof namespace.global !== 'string') {
      throw new TypeError('ptc-plus: invalid binding namespace')
    }
    const functions = namespace.functions
    if (functions === null || typeof functions !== 'object') throw new TypeError(`ptc-plus: invalid ${namespace.global} functions`)
    for (const [member, binding] of Object.entries(functions)) {
      if (typeof binding !== 'function') throw new TypeError(`ptc-plus: binding ${namespace.global}.${member} is not a function`)
    }
    return {
      global: namespace.global,
      members: Object.keys(functions),
      ...(namespace.errorClass === undefined ? {} : { errorClass: namespace.errorClass }),
    }
  })
}

class SessionKernel {
  constructor(config, history, cwd) {
    this.config = config
    this.history = history
    this.cwd = cwd
    this.checkpoints = history.checkpoints
    this.durableHead = history.head
    this.volatile = false
    this.volatileReason = undefined
    this.volatileNoticeShown = false
    this.pendingVolatileDiagnostic = undefined
    this.knownBindings = new Set()
    this.replayed = false
    this.recoveryNotice = history.volatileSuffix.length === 0
      ? undefined
      : recoveryDiagnostic(history.volatileSuffix.length)
    this.worker = undefined
    this.workerReady = undefined
    this.port = undefined
    this.active = undefined
    this.sequence = 0
    this.tail = Promise.resolve()
    this.terminations = new Set()
    this.tentatives = new WeakMap()
    this.disposed = false
  }

  run(request) {
    const execute = () => this.execute(request)
    const result = this.tail.then(execute, execute)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  async execute(request) {
    if (!this.replayed) {
      try {
        await this.replayHistory(request)
        this.replayed = true
      } catch (error) {
        const result = { logs: [], error: { kind: 'recovery', message: `cannot reconstruct REPL from session log: ${messageOf(error)}` } }
        this.completeJournal(request.journal, 'noop', result)
        return result
      }
    }
    const notices = []
    if (this.recoveryNotice !== undefined) {
      notices.push(this.recoveryNotice)
      this.recoveryNotice = undefined
    }
    if (this.pendingVolatileDiagnostic !== undefined) {
      notices.push(this.pendingVolatileDiagnostic)
      this.pendingVolatileDiagnostic = undefined
    }
    const leadingDiagnostics = notices.splice(0)
    if (request.journal !== undefined) request.journal.diagnostics.push(...leadingDiagnostics)
    const result = await this.executeCell(request)
    if (leadingDiagnostics.length > 0) {
      const rendered = leadingDiagnostics.map(item => renderDiagnostic(item, request.program))
      result.logs = [...rendered, ...result.logs]
    }
    return result
  }

  async replayHistory(request) {
    this.knownBindings = new Set()
    const path = pathToHead({ ...this.history, head: this.durableHead })
    for (const node of path) {
      const result = await this.executeCell({ ...request, program: node.code, journal: undefined }, node.journal)
      const completion = node.journal.completion
      if (result.error !== undefined && !['exception', 'invalid-output'].includes(result.error.kind)) {
        throw new Error(`cell replay infrastructure failed (${result.error.kind}): ${result.error.message}`)
      }
      if (completion.kind === 'return' && result.error !== undefined) {
        throw new Error(`cell replay failed: ${result.error.message}`)
      }
      if (completion.kind === 'throw') {
        if (result.error === undefined) throw new Error('cell replay succeeded where the recorded cell failed')
        if (result.error.kind !== completion.error.kind || result.error.message !== completion.error.message) {
          throw new Error('cell replay produced a different semantic failure')
        }
      }
      const prepared = prepareProgram(node.code, this.knownBindings)
      for (const name of prepared.declared) this.knownBindings.add(name)
    }
    this.volatile = false
  }

  completeJournal(journal, status, result, volatileReason, diagnostics = []) {
    if (journal === undefined) return
    journal.status = status
    journal.completion = result.error === undefined
      ? { kind: 'return' }
      : { kind: 'throw', error: { kind: result.error.kind, message: result.error.message } }
    if (volatileReason !== undefined) journal.volatileReason = volatileReason
    if (diagnostics.length > 0) journal.diagnostics.push(...diagnostics)
    if (status === 'volatile') {
      journal.operations = journal.operations.filter(operation => operation.action !== 'save')
    }
    if (status === 'discarded' || status === 'noop') {
      journal.calls.length = 0
      journal.operations.length = 0
    }
  }

  rollbackToDurable() {
    this.volatile = false
    this.volatileReason = undefined
    this.volatileNoticeShown = false
    this.pendingVolatileDiagnostic = undefined
    this.replayed = false
    this.knownBindings = new Set()
  }

  /** Evaluate one live or journal-replay cell. */
  async executeCell(request, replayRecord = undefined) {
    if (this.disposed) {
      const result = { logs: [], error: { kind: 'abort', message: 'session kernel disposed' } }
      this.completeJournal(request.journal, 'noop', result)
      return result
    }
    if (request.signal?.aborted) {
      const result = { logs: [], error: { kind: 'abort', message: String(request.signal.reason) } }
      this.completeJournal(request.journal, 'noop', result)
      return result
    }

    let prepared
    try {
      prepared = prepareProgram(request.program, this.knownBindings)
    } catch (error) {
      const result = { logs: [], error: { kind: 'exception', message: messageOf(error) } }
      const failure = error instanceof PreflightError ? preflightDiagnostic(error) : parseDiagnostic(error, request.program)
      result.error.message = renderDiagnostic(failure, request.program)
      result.logs = [result.error.message]
      this.completeJournal(request.journal, 'noop', result, undefined, [failure])
      return result
    }
    try {
      describeBindings(request.bindings)
    } catch (error) {
      const result = { logs: [], error: { kind: 'exception', message: messageOf(error) } }
      this.completeJournal(request.journal, 'noop', result)
      return result
    }
    if (prepared.collisions.length > 0) {
      const result = { logs: [], error: { kind: 'exception', message: 'top-level binding collision' } }
      const failure = collisionDiagnostic(prepared.collisions)
      result.error.message = renderDiagnostic(failure, request.program)
      result.logs = [result.error.message]
      this.completeJournal(request.journal, 'noop', result, undefined, [failure])
      return result
    }

    let worker
    try {
      worker = await this.ensureWorker()
    } catch (error) {
      const result = { logs: [], error: { kind: 'worker-exit', message: messageOf(error) } }
      this.completeJournal(request.journal, 'discarded', result)
      this.rollbackToDurable()
      return result
    }
    if (request.signal?.aborted) {
      const result = { logs: [], error: { kind: 'abort', message: String(request.signal.reason) } }
      this.completeJournal(request.journal, 'discarded', result)
      this.rollbackToDurable()
      void this.resetWorker(worker)
      return result
    }

    const journal = request.journal
    const desiredDurability = replayRecord === undefined
      ? this.volatile ? 'volatile' : prepared.durability
      : 'durable'
    const bindings = this.withControlBinding(request.bindings, journal, replayRecord)
    const id = ++this.sequence
    return new Promise((resolve) => {
      const started = worker.performance.eventLoopUtilization()
      const settle = (result, terminate = false) => {
        if (this.active?.id !== id) return
        const active = this.active
        clearInterval(active.computeTimer)
        clearTimeout(active.wallTimer)
        request.signal?.removeEventListener('abort', active.onAbort)
        if (journal !== undefined && replayRecord === undefined) {
          if (terminate) {
            this.completeJournal(journal, 'discarded', result, undefined, active.diagnostics)
            this.rollbackToDurable()
          } else {
            const status = active.effectiveDurability
            if (status === 'volatile' && !this.volatile && active.volatileReason !== undefined && replayRecord === undefined) {
              const transition = volatileDiagnostic(active.volatileReason, result.error === undefined)
              active.diagnostics.push(transition)
              this.volatileNoticeShown = true
              result.logs = [renderDiagnostic(transition, request.program), ...result.logs]
            }
            this.completeJournal(journal, status, result, active.volatileReason, active.diagnostics)
            this.tentatives.set(journal, {
              program: request.program,
              declared: prepared.declared,
              worker,
            })
          }
        }
        this.active = undefined
        if (terminate) void this.resetWorker(worker)
        resolve(result)
      }
      const onAbort = () => settle({ logs: [], error: { kind: 'abort', message: String(request.signal?.reason) } }, true)
      const computeTimer = setInterval(() => {
        if (worker.performance.eventLoopUtilization(started).active > this.config.computeMs) {
          settle({ logs: [], error: { kind: 'timeout', message: `compute budget exhausted (${this.config.computeMs}ms busy)` } }, true)
        }
      }, Math.min(100, this.config.computeMs))
      const wallTimer = setTimeout(() => {
        settle({ logs: [], error: { kind: 'timeout', message: `wall-clock ceiling reached (${this.config.maxWallMs}ms)` } }, true)
      }, this.config.maxWallMs)

      this.active = {
        id,
        request: { ...request, bindings },
        resolve: settle,
        computeTimer,
        wallTimer,
        onAbort,
        journal,
        replay: replayRecord,
        replayIndex: 0,
        replayNextSettle: 0,
        replayPending: new Map(),
        settlementSequence: 0,
        diagnostics: [],
        desiredDurability,
        effectiveDurability: desiredDurability,
        volatileReason: this.volatile ? this.volatileReason : prepared.reason || undefined,
        control: { names: new Set(this.checkpoints.keys()) },
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      if (request.signal?.aborted) {
        onAbort()
        return
      }
      try {
        const effectiveNamespaces = describeBindings(bindings)
        this.port.postMessage({
          type: 'run', id, program: prepared.code, namespaces: effectiveNamespaces,
          maxOutputBytes: this.config.maxOutputBytes, durability: desiredDurability,
        })
      } catch (error) {
        settle({ logs: [], error: { kind: 'worker-exit', message: messageOf(error) } }, true)
      }
    })
  }

  withControlBinding(bindings, journal, replayRecord) {
    if (replayRecord === undefined && journal === undefined) return bindings
    const control = async args => {
      const parsed = stateArguments(args)
      if (replayRecord !== undefined) return { action: parsed.action, ...(parsed.name === undefined ? {} : { name: parsed.name }) }
      return this.controlState(parsed)
    }
    return [...bindings, { global: 'repl', functions: { state: control } }]
  }

  controlState(parsed) {
    const active = this.active
    if (active?.control === undefined || active.journal === undefined) {
      throw new Error('REPL state control is unavailable outside a cell')
    }
    const { action, name } = parsed
    if (action === 'list') {
      return {
        names: [...active.control.names].sort(),
        mode: active.effectiveDurability,
        ...(active.volatileReason === undefined ? {} : { volatileReason: active.volatileReason }),
      }
    }
    if (action === 'save') {
      if (active.effectiveDurability === 'volatile') {
        throw new Error('cannot save a durable REPL state from a volatile segment; restore a durable state first')
      }
      active.control.names.add(name)
      active.journal.operations.push({ action, name })
      return { action, name, saved: true }
    }
    if (action === 'delete') {
      active.control.names.delete(name)
      active.journal.operations.push({ action, name })
      return { action, name, deleted: true }
    }
    if (name !== undefined && !active.control.names.has(name)) throw new Error(`REPL state "${name}" does not exist`)
    active.journal.operations.push({ action, ...(name === undefined ? {} : { name }) })
    return { action, ...(name === undefined ? {} : { name }), restored: true }
  }

  finalizeJournal(journal, confirmed) {
    const tentative = this.tentatives.get(journal)
    if (tentative === undefined) return
    this.tentatives.delete(journal)
    if (!confirmed) {
      if (journal.status === 'durable' || journal.status === 'volatile') {
        this.volatile = true
        this.volatileReason ??= journal.volatileReason ?? 'run_code journal was not preserved in the final tool result'
        if (!this.volatileNoticeShown) {
          this.pendingVolatileDiagnostic = volatileDiagnostic(this.volatileReason, journal.completion?.kind === 'return')
          this.volatileNoticeShown = true
        }
        for (const name of tentative.declared) this.knownBindings.add(name)
      }
      return
    }
    if (journal.status === 'durable') {
      const normalized = normalizeJournal(journal)
      const node = Object.freeze({ code: tentative.program, journal: normalized, parent: this.durableHead })
      const index = this.history.nodes.push(node) - 1
      this.durableHead = index
      this.history.head = index
      for (const name of tentative.declared) this.knownBindings.add(name)
      this.applyConfirmedOperations(journal.operations, index, tentative.worker)
      return
    }
    if (journal.status === 'volatile') {
      this.volatile = true
      this.volatileReason ??= journal.volatileReason
      this.volatileNoticeShown = true
      for (const name of tentative.declared) this.knownBindings.add(name)
      this.applyConfirmedOperations(journal.operations, undefined, tentative.worker)
    }
  }

  applyConfirmedOperations(operations, index, worker) {
    for (const operation of operations) {
      if (operation.action === 'save') {
        if (index !== undefined) this.checkpoints.set(operation.name, index)
      } else if (operation.action === 'delete') {
        this.checkpoints.delete(operation.name)
      } else {
        this.durableHead = operation.name === undefined
          ? index === undefined ? this.durableHead : this.history.nodes[index]?.parent
          : this.checkpoints.get(operation.name)
        this.history.head = this.durableHead
        this.rollbackToDurable()
        void this.resetWorker(worker)
      }
    }
  }

  async ensureWorker() {
    if (this.worker !== undefined) return this.workerReady
    const worker = new Worker(WORKER_URL, {
      env: {},
      execArgv: [],
      workerData: this.cwd === undefined ? {} : { cwd: this.cwd },
      resourceLimits: { maxOldGenerationSizeMb: this.config.maxOldGenerationSizeMb },
      stdout: true,
      stderr: true,
    })
    worker.stdout.resume()
    worker.stderr.resume()
    worker.on('error', error => this.failWorker(worker, `worker error: ${messageOf(error)}`))
    worker.on('exit', code => this.failWorker(worker, `worker exited with code ${code}`))
    this.worker = worker
    this.workerReady = new Promise((resolve, reject) => {
      const onError = error => reject(error)
      const onExit = code => reject(new Error(`worker exited with code ${code} before opening its private channel`))
      worker.once('error', onError)
      worker.once('exit', onExit)
      worker.once('message', (message) => {
        worker.removeListener('error', onError)
        worker.removeListener('exit', onExit)
        if (message?.type === 'startup-error' && typeof message.error === 'string') {
          reject(new Error(message.error))
          void this.resetWorker(worker)
          return
        }
        if (message?.type !== 'ready' || typeof message.port?.postMessage !== 'function') {
          reject(new Error('kernel worker returned an invalid private channel'))
          void this.resetWorker(worker)
          return
        }
        this.port = message.port
        this.port.on('message', value => this.onMessage(worker, value))
        resolve(worker)
      })
    })
    return this.workerReady
  }

  onMessage(worker, message) {
    if (worker !== this.worker || message === null || typeof message !== 'object') return
    if (message.type === 'call') {
      void this.invokeBinding(worker, message)
      return
    }
    if (message.type === 'output-limit' && this.active?.id === message.id) {
      const logs = Array.isArray(message.logs) && message.logs.every(log => typeof log === 'string') ? message.logs : []
      this.active.resolve({ logs, error: { kind: 'output-limit', message: `output exceeded ${this.config.maxOutputBytes} bytes` } }, true)
      return
    }
    if (message.type !== 'done' || this.active?.id !== message.id) return

    const active = this.active
    const logs = Array.isArray(message.logs) && message.logs.every(log => typeof log === 'string') ? message.logs : []
    if (!['durable', 'volatile'].includes(message.durability)) {
      active.resolve({ logs, error: { kind: 'worker-exit', message: 'kernel returned an invalid durability state' } }, true)
      return
    }
    active.effectiveDurability = message.durability
    if (typeof message.volatileReason === 'string') active.volatileReason = message.volatileReason
    if (active.replay !== undefined && message.durability !== 'durable') {
      active.resolve({ logs, error: { kind: 'recovery', message: 'durable history requested a volatile capability during replay' } }, true)
      return
    }
    if (active.replay !== undefined
      && (active.replayIndex !== active.replay.calls.length || active.replayPending.size !== 0)) {
      active.resolve({ logs, error: { kind: 'recovery', message: 'session log replay consumed a different host-call transcript' } }, true)
      return
    }
    const bytes = Buffer.byteLength(JSON.stringify({ logs, value: message.value }), 'utf8')
    if (bytes > this.config.maxOutputBytes) {
      active.resolve({ logs: [], error: { kind: 'output-limit', message: `output exceeded ${this.config.maxOutputBytes} bytes` } }, true)
      return
    }
    if (typeof message.error === 'string') {
      const rawError = {
        kind: 'exception',
        name: typeof message.errorName === 'string' ? message.errorName : 'Error',
        message: message.error,
      }
      const actualFailure = exceptionDiagnostic(rawError, message.cause)
      const recordedFailure = active.replay?.diagnostics?.find(item => item.code === 'PTC-X001')
      const failure = recordedFailure?.message === actualFailure.message ? recordedFailure : actualFailure
      const error = { kind: 'exception', message: renderDiagnostic(failure, active.request.program) }
      active.diagnostics.push(failure)
      active.resolve({ logs: [...logs, error.message], error })
      return
    }
    if (typeof message.invalidOutput === 'string') {
      active.resolve({ logs, error: { kind: 'invalid-output', message: message.invalidOutput } })
      return
    }
    try {
      active.resolve({ logs, ...(message.value === undefined ? {} : { value: decodeJson(message.value) }) })
    } catch (error) {
      active.resolve({ logs, error: { kind: 'invalid-output', message: messageOf(error) } })
    }
  }

  async invokeBinding(worker, message) {
    const active = this.active
    if (worker !== this.worker || active?.id !== message.runId) {
      this.port?.postMessage({ type: 'reply', runId: message.runId, id: message.id, ok: false, error: 'PTC execution lease expired' })
      return
    }
    const namespace = active.request.bindings.find(binding => binding.global === message.global)
    const binding = namespace?.functions?.[message.member]
    if (typeof binding !== 'function') {
      this.port.postMessage({ type: 'reply', runId: message.runId, id: message.id, ok: false, error: `unknown binding ${message.global}.${message.member}` })
      return
    }
    let args
    try {
      args = decodeJson(message.args)
    } catch (error) {
      this.port.postMessage({ type: 'reply', runId: message.runId, id: message.id, ok: false, error: messageOf(error) })
      return
    }
    const recorded = active.replay?.calls?.[active.replayIndex]
    if (active.replay !== undefined) {
      active.replayIndex += 1
      if (recorded === undefined || recorded.global !== message.global || recorded.member !== message.member
        || !sameJson(recorded.args, args)) {
        this.port.postMessage({ type: 'reply', runId: message.runId, id: message.id, ok: false, error: 'session log replay diverged at a host binding call' })
        return
      }
      active.replayPending.set(recorded.settle, { message, recorded })
      this.flushReplayReplies(worker, active)
      return
    }
    const call = active.journal === undefined ? undefined : { global: message.global, member: message.member, args }
    if (call !== undefined) active.journal.calls.push(call)
    try {
      const value = await binding(args)
      if (call !== undefined) {
        call.ok = true
        call.value = value
        call.settle = active.settlementSequence++
      }
      if (worker === this.worker) this.port.postMessage({ type: 'reply', runId: message.runId, id: message.id, ok: true, value: encodeJson(value) })
    } catch (error) {
      const cause = hostCause(error)
      if (call !== undefined) {
        call.ok = false
        call.error = messageOf(error)
        call.settle = active.settlementSequence++
      }
      if (worker === this.worker) {
        this.port.postMessage({
          type: 'reply', runId: message.runId, id: message.id, ok: false,
          error: messageOf(error), cause,
        })
      }
    }
  }

  flushReplayReplies(worker, active) {
    while (worker === this.worker) {
      const pending = active.replayPending.get(active.replayNextSettle)
      if (pending === undefined) return
      active.replayPending.delete(active.replayNextSettle)
      active.replayNextSettle += 1
      const { message, recorded } = pending
      this.port.postMessage(recorded.ok
        ? { type: 'reply', runId: message.runId, id: message.id, ok: true, value: encodeJson(recorded.value) }
        : { type: 'reply', runId: message.runId, id: message.id, ok: false, error: recorded.error })
    }
  }

  failWorker(worker, message) {
    if (worker !== this.worker) return
    this.worker = undefined
    this.workerReady = undefined
    this.port?.close()
    this.port = undefined
    this.active?.resolve({ logs: [], error: { kind: 'worker-exit', message } }, true)
  }

  async resetWorker(worker) {
    if (this.worker === worker) {
      this.worker = undefined
      this.workerReady = undefined
      this.port?.close()
      this.port = undefined
    }
    const termination = worker.terminate()
    this.terminations.add(termination)
    try {
      await termination
    } finally {
      this.terminations.delete(termination)
    }
  }

  async dispose() {
    this.disposed = true
    const worker = this.worker
    if (worker !== undefined) {
      this.active?.resolve({ logs: [], error: { kind: 'abort', message: 'session kernel disposed' } }, true)
      await this.resetWorker(worker)
    }
    await Promise.all([...this.terminations])
    await this.tail
  }
}

export class SessionRuntime {
  constructor(config = {}) {
    this.config = resolveConfig(config)
    this.kernels = new Map()
    this.pendingNoops = new Map()
    this.disposed = false
  }

  async run(sessionContext, request) {
    if (this.disposed) return Promise.resolve({ logs: [], error: { kind: 'abort', message: 'PTC runtime disposed' } })
    const sessionId = typeof sessionContext === 'object' && sessionContext !== null
      ? String(sessionContext.id)
      : String(sessionContext)
    let kernel = this.kernels.get(sessionId)
    if (kernel === undefined) {
      let history
      try {
        history = recoverJournal(
          typeof sessionContext === 'object' ? sessionContext.session : undefined,
          typeof sessionContext === 'object' ? sessionContext.callId : undefined,
        )
      } catch (error) {
        return { logs: [], error: { kind: 'recovery', message: messageOf(error) } }
      }
      const cwd = typeof sessionContext === 'object' && typeof sessionContext.session?.header?.cwd === 'string'
        ? sessionContext.session.header.cwd
        : undefined
      kernel = new SessionKernel(this.config, history, cwd)
      this.kernels.set(sessionId, kernel)
    }
    const journal = createJournal(this.pendingNoops.get(sessionId) ?? [])
    const result = await kernel.run({ ...request, journal })
    if (typeof sessionContext === 'object' && sessionContext !== null) {
      sessionContext.journal = journal
      sessionContext.kernel = kernel
    }
    const { journal: _ignored, ...publicResult } = result
    return publicResult
  }

  noteNoop(sessionId, callId) {
    const id = String(sessionId)
    let calls = this.pendingNoops.get(id)
    if (calls === undefined) {
      calls = new Set()
      this.pendingNoops.set(id, calls)
    }
    calls.add(String(callId))
  }

  finalize(sessionContext, confirmed) {
    const journal = sessionContext?.journal
    const kernel = sessionContext?.kernel
    if (journal === undefined || kernel === undefined) return
    kernel.finalizeJournal(journal, confirmed)
    if (!confirmed) return
    const noops = this.pendingNoops.get(String(sessionContext.id))
    if (noops === undefined) return
    for (const callId of journal.confirms ?? []) noops.delete(callId)
    if (noops.size === 0) this.pendingNoops.delete(String(sessionContext.id))
  }

  async disposeSession(sessionId) {
    const id = String(sessionId)
    const kernel = this.kernels.get(id)
    this.pendingNoops.delete(id)
    if (kernel === undefined) return
    this.kernels.delete(id)
    await kernel.dispose()
  }

  async dispose() {
    this.disposed = true
    const kernels = [...this.kernels.values()]
    this.kernels.clear()
    await Promise.all(kernels.map(kernel => kernel.dispose()))
  }
}
