import { stripTypeScriptTypes } from 'node:module'
import { parse } from 'acorn'

const STRIP_PREFIX = 'async function __ptc_cell__(){\n'
const STRIP_SUFFIX = '\n}'
const RETURN_SIGNAL = '__dsh_ptc_return_signal_7f3a__'
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

/**
 * Pure AST analysis for PTC cells: binding inventory, durability classification,
 * return rewriting, and program preparation. This module owns no worker, journal,
 * or session state so its behavior is fully testable in isolation.
 */

export function declarationSpan(node) {
  const start = node.loc?.start
  /* c8 ignore next */
  const end = node.loc?.end ?? start
  /* c8 ignore next */
  if (start === undefined) return undefined
  return {
    line: Math.max(1, start.line - 1),
    column: start.column + 1,
    /* c8 ignore next */
    ...(end === undefined ? {} : {
      end: {
        line: Math.max(1, end.line - 1),
        column: end.column + 1,
      },
    }),
  }
}

function walkPattern(pattern, visit) {
  if (pattern === null || typeof pattern !== 'object') return
  if (pattern.type === 'Identifier') {
    visit(pattern)
    return
  }
  if (pattern.type === 'RestElement') return walkPattern(pattern.argument, visit)
  if (pattern.type === 'AssignmentPattern') return walkPattern(pattern.left, visit)
  if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) walkPattern(element, visit)
    return
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      /* c8 ignore next */
      walkPattern(property.type === 'RestElement' ? property.argument : property.value, visit)
    }
  }
}

function addPatternBindings(pattern, names) {
  walkPattern(pattern, node => names.add(node.name))
}

function addPatternDeclarations(pattern, declarations) {
  walkPattern(pattern, node => declarations.push({ name: node.name, span: declarationSpan(node) }))
}

function topLevelBindings(body) {
  return new Set(topLevelDeclarations(body).map(declaration => declaration.name))
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

const AST_METADATA_KEYS = new Set(['start', 'end', 'loc', 'range'])
const SKIP_AST_CHILDREN = Symbol('skip AST children')

function walkAst(node, enter, leave = undefined, context = undefined, parent = undefined, parentKey = undefined) {
  if (node === null || typeof node !== 'object') return
  const entered = enter(node, parent, parentKey, context)
  if (entered === SKIP_AST_CHILDREN) return
  const childContext = entered === undefined ? context : entered
  for (const [key, value] of Object.entries(node)) {
    if (AST_METADATA_KEYS.has(key)) continue
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, enter, leave, childContext, node, key)
    } else {
      walkAst(value, enter, leave, childContext, node, key)
    }
  }
  leave?.(node, parent, parentKey, childContext)
}

function functionBindings(node) {
  const names = new Set()
  if (node.id !== null && node.id !== undefined) names.add(node.id.name)
  /* c8 ignore next */
  for (const param of node.params ?? []) addPatternBindings(param, names)
  walkAst(node.body, (current) => {
    if (current !== node && isFunction(current)) {
      if (current.type === 'FunctionDeclaration' && current.id !== null) names.add(current.id.name)
      return SKIP_AST_CHILDREN
    }
    if (current.type === 'VariableDeclaration' && current.kind === 'var') {
      for (const declaration of current.declarations) addPatternBindings(declaration.id, names)
    }
  })
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
  /* c8 ignore next */
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
  /* c8 ignore next */
  if (node.name !== 'process' || parent?.type !== 'MemberExpression' || parent.object !== node) return false
  const member = parent.computed
    ? parent.property?.type === 'Literal' ? parent.property.value : undefined
    /* c8 ignore next */
    : parent.property?.type === 'Identifier' ? parent.property.name : undefined
  return ['stdout', 'stderr', 'cwd'].includes(member)
}

function isFunction(node) {
  return node.type === 'FunctionDeclaration'
    || node.type === 'FunctionExpression'
    || node.type === 'ArrowFunctionExpression'
}

export class PreflightError extends Error {
  constructor(message, node) {
    super(message)
    this.span = declarationSpan(node)
  }
}

/** Conservatively classify a cell before giving it non-journalable capability. */
export function classifyDurability(code, knownBindings = new Set()) {
  const tree = parse(`${STRIP_PREFIX}${code}${STRIP_SUFFIX}`, { ecmaVersion: 'latest', sourceType: 'script', locations: true })
  const outer = tree.body[0]
  /* c8 ignore next */
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
  walkAst(outer.body, (node, parent, parentKey, scopes) => {
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
    return nestedScopes
  }, undefined, [rootBindings], outer, 'body')
  return {
    durability: reasons.size === 0 ? 'durable' : 'volatile',
    reason: [...reasons].join(', '),
    declared,
  }
}

function rewriteCellReturns(code) {
  const wrapped = STRIP_PREFIX + code + STRIP_SUFFIX
  const tree = parse(wrapped, { ecmaVersion: 'latest', sourceType: 'script' })
  const outer = tree.body[0]
  /* c8 ignore next */
  if (outer?.type !== 'FunctionDeclaration') throw new Error('ptc-plus: failed to parse cell wrapper')
  const offset = STRIP_PREFIX.length
  const edits = []
  const signal = `globalThis[${JSON.stringify(RETURN_SIGNAL)}]`
  let catchSequence = 0

  walkAst(outer.body, (node) => {
    if (node !== outer.body && isFunction(node)) return SKIP_AST_CHILDREN
    if (node.type === 'ReturnStatement') {
      const start = node.start - offset
      const end = node.end - offset
      const argument = node.argument === null
        ? ''
        : code.slice(node.argument.start - offset, node.argument.end - offset)
      edits.push({ start, end, text: `throw new ${signal}(${argument})` })
      return SKIP_AST_CHILDREN
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
  })

  /* c8 ignore next */
  edits.sort((left, right) => right.start - left.start || right.end - left.end)
  let rewritten = code
  for (const edit of edits) {
    rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end)
  }
  return rewritten
}

export function reservedBindingNames(bindings) {
  const names = new Set(['repl'])
  if (!Array.isArray(bindings)) return names
  for (const namespace of bindings) {
    if (typeof namespace?.global === 'string') names.add(namespace.global)
    if (typeof namespace?.errorClass?.name === 'string') names.add(namespace.errorClass.name)
  }
  return names
}

export function prepareProgram(program, knownBindings, looseTopLevelRedeclarations, reservedBindings = new Set()) {
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
    /* c8 ignore next */
    throw stripError
  }
  const code = stripped.slice(STRIP_PREFIX.length, stripped.length - STRIP_SUFFIX.length)
  const tree = parse(stripped, { ecmaVersion: 'latest', sourceType: 'script', locations: true })
  const outer = tree.body[0]
  /* c8 ignore next */
  const declarations = outer?.type === 'FunctionDeclaration' ? topLevelDeclarations(outer.body.body) : []
  const collisionFor = declaration => ({
      name: declaration.name,
      /* c8 ignore next */
      start: declaration.span === undefined ? { line: 1, column: 1 } : {
        line: declaration.span.line,
        column: declaration.span.column,
      },
      /* c8 ignore next */
      ...(declaration.span?.end === undefined ? {} : { end: declaration.span.end }),
    })
  const reserved = declarations.filter(declaration => reservedBindings.has(declaration.name))
  if (reserved.length > 0) {
    const classification = classifyDurability(code, knownBindings)
    return {
      code,
      ...classification,
      collisions: reserved.map(collisionFor),
      redeclared: [],
    }
  }
  let executableCode = code
  let collisions
  const redeclared = []
  if (!looseTopLevelRedeclarations || outer?.type !== 'FunctionDeclaration') {
    collisions = declarations.filter(declaration => knownBindings.has(declaration.name)).map(collisionFor)
  } else {
    const offset = STRIP_PREFIX.length
    const replacements = []
    const rejected = []
    for (const statement of outer.body.body) {
      if (statement.type !== 'VariableDeclaration') {
        if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration')
          && statement.id !== null && knownBindings.has(statement.id.name)) {
          rejected.push({ name: statement.id.name, span: declarationSpan(statement.id) })
        }
        continue
      }
      const entries = []
      let statementRejected = false
      for (const declarator of statement.declarations) {
        const bindings = []
        addPatternDeclarations(declarator.id, bindings)
        const existing = bindings.filter(binding => knownBindings.has(binding.name))
        if (existing.length > 0 && existing.length < bindings.length) {
          rejected.push(...existing)
          statementRejected = true
          continue
        }
        entries.push({ declarator, bindings, existing })
      }
      if (statementRejected) continue
      if (!entries.some(entry => entry.existing.length > 0)) {
        if (statement.kind === 'const') {
          replacements.push({
            start: statement.start - offset,
            end: statement.start - offset + statement.kind.length,
            text: 'let',
          })
        }
        continue
      }
      const parts = []
      for (const { declarator, bindings, existing } of entries) {
        const pattern = code.slice(declarator.id.start - offset, declarator.id.end - offset)
        if (existing.length === bindings.length && bindings.length > 0) {
          redeclared.push(...existing.map(collisionFor))
          const initializer = declarator.init === null
            ? 'undefined'
            : code.slice(declarator.init.start - offset, declarator.init.end - offset)
          parts.push(`;(${pattern} = ${initializer});`)
        } else {
          const declaration = code.slice(declarator.start - offset, declarator.end - offset)
          /* c8 ignore next */
          parts.push(`${statement.kind === 'var' ? 'var' : 'let'} ${declaration};`)
        }
      }
      replacements.push({
        start: statement.start - offset,
        end: statement.end - offset,
        text: parts.join('\n'),
      })
    }
    collisions = rejected.map(collisionFor)
    if (collisions.length === 0) {
      replacements.sort((left, right) => right.start - left.start)
      for (const replacement of replacements) {
        executableCode = executableCode.slice(0, replacement.start)
          + replacement.text
          + executableCode.slice(replacement.end)
      }
    }
  }
  const classification = classifyDurability(code, knownBindings)
  return {
    code: collisions.length === 0 ? rewriteCellReturns(executableCode) : code,
    ...classification,
    collisions,
    redeclared,
  }
}

export function describeBindings(bindings) {
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
