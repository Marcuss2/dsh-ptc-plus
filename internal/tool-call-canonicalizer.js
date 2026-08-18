const PROGRAM_CALL_NAMES = new Set([
  'host.invoke', 'workspace.readLines', 'workspace.findFiles', 'code.run', 'repl.state',
])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function ownKeysOnly(value, allowed, required) {
  if (!isPlainObject(value)) return false
  const keys = Object.keys(value)
  if (keys.some(key => !allowed.has(key))) return false
  return required.every(key => Object.hasOwn(value, key))
}

function isReadArguments(value) {
  return ownKeysOnly(value, new Set(['file_path', 'offset', 'limit']), ['file_path'])
    && typeof value.file_path === 'string'
    && (value.offset === undefined || Number.isSafeInteger(value.offset) && value.offset > 0)
    && (value.limit === undefined || Number.isSafeInteger(value.limit) && value.limit > 0)
}

function isGlobArguments(value) {
  return ownKeysOnly(value, new Set(['pattern', 'path']), ['pattern'])
    && typeof value.pattern === 'string'
    && (value.path === undefined || typeof value.path === 'string')
}

function projectionSchemaCompatible(schema, kind) {
  const parameters = schema?.parameters
  if (!isPlainObject(parameters)) return false
  const expected = kind === 'read'
    ? { required: ['file_path'], fields: { file_path: 'string', offset: 'number', limit: 'number' } }
    : { required: ['pattern'], fields: { pattern: 'string', path: 'string' } }
  let properties = parameters
  let required = Object.keys(parameters).filter(key => parameters[key]?.required === true)
  if (isPlainObject(parameters.properties)) {
    properties = parameters.properties
    required = Array.isArray(parameters.required) ? parameters.required : []
  }
  if (Object.keys(properties).sort().join('\0') !== Object.keys(expected.fields).sort().join('\0')) return false
  if ([...required].sort().join('\0') !== [...expected.required].sort().join('\0')) return false
  return Object.entries(expected.fields).every(([name, type]) => {
    const property = properties[name]
    return isPlainObject(property) && (property.type === type || type === 'number' && property.type === 'integer')
  })
}

function parseNativeArguments(raw, name, nativeSchemas) {
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (name === 'read' && projectionSchemaCompatible(nativeSchemas.get(name), 'read')
    && isReadArguments(value)) return value
  if (name === 'glob' && projectionSchemaCompatible(nativeSchemas.get(name), 'glob')
    && isGlobArguments(value)) return value
  if (name === 'host.invoke' && ownKeysOnly(value, new Set(['name', 'args']), ['name', 'args'])
    && typeof value.name === 'string' && nativeSchemas.has(value.name)
    && (value.args === null || ['object', 'string', 'number', 'boolean'].includes(typeof value.args))) {
    return value
  }
  if (name === 'workspace.readLines' && ownKeysOnly(value, new Set(['path', 'offset', 'limit']), ['path'])
    && typeof value.path === 'string'
    && (value.offset === undefined || Number.isSafeInteger(value.offset) && value.offset > 0)
    && (value.limit === undefined || Number.isSafeInteger(value.limit) && value.limit > 0)) return value
  if (name === 'workspace.findFiles' && ownKeysOnly(value, new Set(['pattern', 'root']), ['pattern'])
    && typeof value.pattern === 'string'
    && (value.root === undefined || typeof value.root === 'string')) return value
  if (name === 'code.run' && ownKeysOnly(value, new Set(['code', 'description']), ['code', 'description'])
    && typeof value.code === 'string' && typeof value.description === 'string') return value
  if (name === 'repl.state' && ownKeysOnly(value, new Set(['action', 'name']), ['action'])
    && ['list', 'save', 'restore', 'delete'].includes(value.action)
    && (value.action === 'restore'
      ? value.name === undefined || typeof value.name === 'string' && value.name.length > 0
      : value.action === 'list'
        ? value.name === undefined
        : typeof value.name === 'string' && value.name.length > 0)) return value
  // Native arguments are checked by the live definition at dispatch time.
  // Keeping this boundary lossless lets new tools and fields work unchanged.
  if (nativeSchemas.has(name)) return value
  return undefined
}

function jsonSource(value) {
  return JSON.stringify(JSON.stringify(value))
}

function canonicalCode(name, args, nativeSchemas) {
  const literal = jsonSource(args)
  if (name === 'read' && projectionSchemaCompatible(nativeSchemas.get(name), 'read') && isReadArguments(args)) {
    return `{\n  // PTC Plus canonicalized this native-shaped call into the session REPL.\n  const __ptcArgs = JSON.parse(${literal})\n  return await workspace.readLines({\n    path: __ptcArgs.file_path,\n    ...(__ptcArgs.offset === undefined ? {} : { offset: __ptcArgs.offset }),\n    ...(__ptcArgs.limit === undefined ? {} : { limit: __ptcArgs.limit }),\n  })\n}`
  }
  if (name === 'glob' && projectionSchemaCompatible(nativeSchemas.get(name), 'glob') && isGlobArguments(args)) {
    return `{\n  // PTC Plus canonicalized this native-shaped call into the session REPL.\n  const __ptcArgs = JSON.parse(${literal})\n  return await workspace.findFiles({\n    pattern: __ptcArgs.pattern,\n    ...(__ptcArgs.path === undefined ? {} : { root: __ptcArgs.path }),\n  })\n}`
  }
  if (name === 'workspace.readLines') {
    return `{\n  // PTC Plus kept this program capability inside the session REPL.\n  const __ptcArgs = JSON.parse(${literal})\n  return await workspace.readLines(__ptcArgs)\n}`
  }
  if (name === 'workspace.findFiles') {
    return `{\n  // PTC Plus kept this program capability inside the session REPL.\n  const __ptcArgs = JSON.parse(${literal})\n  return await workspace.findFiles(__ptcArgs)\n}`
  }
  if (name === 'host.invoke') {
    return `{\n  // PTC Plus kept this program capability inside the session REPL.\n  const __ptcArgs = JSON.parse(${literal})\n  return await host.invoke(__ptcArgs)\n}`
  }
  if (name === 'code.run') {
    return `{\n  // PTC Plus kept this program capability inside the session REPL.\n  const __ptcArgs = JSON.parse(${literal})\n  return await code.run(__ptcArgs)\n}`
  }
  if (name === 'repl.state') {
    return `{\n  // PTC Plus kept this program capability inside the session REPL.\n  const __ptcArgs = JSON.parse(${literal})\n  return await repl.state(__ptcArgs)\n}`
  }
  return `{\n  // PTC Plus canonicalized this native-shaped call into the session REPL.\n  const __ptcArgs = JSON.parse(${literal})\n  return await host.invoke({ name: ${JSON.stringify(name)}, args: __ptcArgs })\n}`
}

function extractCall(chunks, index) {
  let name
  let id
  let args = ''
  let block
  let deltaIndex = -1
  let invalidId = false
  let inconsistent = false
  for (let position = 0; position < chunks.length; position += 1) {
    const chunk = chunks[position]
    if (chunk.index !== index) continue
    if (chunk.type === 'tool-call-delta') {
      if (chunk.id === undefined) invalidId = true
      else if (id !== undefined && id !== chunk.id) inconsistent = true
      else id = chunk.id
      if (typeof chunk.name === 'string' && chunk.name.length > 0) {
        if (name !== undefined && name !== chunk.name) inconsistent = true
        else name = chunk.name
      }
      args += chunk.argumentsDelta
      if (deltaIndex < 0) deltaIndex = position
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
      block = chunk.block
      if (id !== undefined && id !== block.id) inconsistent = true
      else id ??= block.id
      if (name !== undefined && name !== block.name) inconsistent = true
      else name ??= block.name
      if (args.length === 0) args = block.arguments
      else if (args !== block.arguments) inconsistent = true
    }
  }
  return { name, id, args, deltaIndex, block, invalidId, inconsistent }
}

function transformedChunks(chunks, affected) {
  const firstDelta = new Map(affected.map(item => [item.index, item]))
  const output = []
  const emitted = new Set()
  for (const chunk of chunks) {
    if (chunk.type === 'finish') {
      // Replay metadata describes the provider's original content. Once a
      // tool block changes, only the normalized Harness content is authoritative.
      const { replayState: _replayState, ...finish } = chunk
      output.push(finish)
      continue
    }
    const item = firstDelta.get(chunk.index)
    if (item === undefined) {
      output.push(chunk)
      continue
    }
    if (chunk.type === 'block-start') {
      output.push({ ...chunk, blockType: 'tool-call' })
    } else if (chunk.type === 'tool-call-delta') {
      if (emitted.has(chunk.index)) continue
      emitted.add(chunk.index)
      output.push({ ...chunk, name: 'run_code', argumentsDelta: item.arguments })
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
      output.push({
        ...chunk,
        block: { type: 'tool-call', id: item.id, name: 'run_code', arguments: item.arguments },
      })
    } else {
      output.push(chunk)
    }
  }
  return output
}

/** Only plugin-owned program names are fixed; native names come from live schemas. */
export const canonicalizableToolNames = PROGRAM_CALL_NAMES

/**
 * Transform a complete LLM stream only when it is a strict PTC request.
 * The source stream is collected so malformed/incomplete calls can pass through
 * byte-for-byte; all non-tool chunks and provider accounting remain unchanged.
 */
export async function* canonicalizeToolCallStream(source, options = {}) {
  const chunks = []
  for await (const chunk of source) chunks.push(chunk)
  if (options.enabled === false || !Array.isArray(options.tools) || options.tools.length !== 1
    || options.tools[0]?.name !== 'run_code') {
    yield* chunks
    return
  }
  const nativeSchemas = options.nativeSchemas instanceof Map
    ? new Map([...options.nativeSchemas].filter(([name]) => name !== 'run_code'))
    : new Map()
  const indices = [...new Set(chunks.filter(chunk => chunk.type === 'tool-call-delta' || chunk.type === 'block-end')
    .map(chunk => chunk.index))]
  const affected = []
  for (const index of indices) {
    const call = extractCall(chunks, index)
    const programCallAllowed = (call.name === 'workspace.readLines' && nativeSchemas.has('read'))
      || (call.name === 'workspace.findFiles' && nativeSchemas.has('glob'))
      || PROGRAM_CALL_NAMES.has(call.name)
    if ((!nativeSchemas.has(call.name) && !programCallAllowed)
      || call.id === undefined || call.invalidId || call.inconsistent || call.deltaIndex < 0) continue
    const args = parseNativeArguments(call.args, call.name, nativeSchemas)
    if (args === undefined) continue
    const code = canonicalCode(call.name, args, nativeSchemas)
    const description = `Canonicalize ${call.name} in the session REPL`
    const argumentsValue = JSON.stringify({ code, description })
    affected.push({ index, id: call.id, arguments: argumentsValue })
  }
  yield* (affected.length === 0 ? chunks : transformedChunks(chunks, affected))
}
