function parseArguments(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false }
  }
}

function jsonValuesEqual(left, right) {
  const pending = [[left, right]]
  while (pending.length > 0) {
    const [currentLeft, currentRight] = pending.pop()
    if (Object.is(currentLeft, currentRight)) continue
    if (currentLeft === null || currentRight === null
      || typeof currentLeft !== 'object' || typeof currentRight !== 'object'
      || Array.isArray(currentLeft) !== Array.isArray(currentRight)) return false
    const leftKeys = Object.keys(currentLeft)
    const rightKeys = Object.keys(currentRight)
    if (leftKeys.length !== rightKeys.length
      || leftKeys.some(key => !Object.hasOwn(currentRight, key))) return false
    for (const key of leftKeys) pending.push([currentLeft[key], currentRight[key]])
  }
  return true
}

function containsOwnProto(value) {
  const pending = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current !== 'object') continue
    if (!Array.isArray(current) && Object.hasOwn(current, '__proto__')) return true
    for (const child of Object.values(current)) pending.push(child)
  }
  return false
}

const MAX_DIRECT_LITERAL_DEPTH = 128

function jsonContainerDepth(value) {
  let maximum = 0
  const pending = [{ value, depth: 0 }]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current.value === null || typeof current.value !== 'object') continue
    const depth = current.depth + 1
    if (depth > maximum) maximum = depth
    for (const child of Object.values(current.value)) pending.push({ value: child, depth })
  }
  return maximum
}

function numberLiteral(value) {
  if (Object.is(value, -0)) return '-0'
  if (value === Infinity) return '1e400'
  if (value === -Infinity) return '-1e400'
  return JSON.stringify(value)
}

function safeJsonLiteral(value) {
  const output = []
  const pending = [{ kind: 'value', value }]
  while (pending.length > 0) {
    const item = pending.pop()
    if (item.kind === 'text') {
      output.push(item.value)
      continue
    }
    const current = item.value
    if (current === null) output.push('null')
    else if (typeof current === 'string') output.push(JSON.stringify(current))
    else if (typeof current === 'boolean') output.push(String(current))
    else if (typeof current === 'number') output.push(numberLiteral(current))
    else if (Array.isArray(current)) {
      output.push('[')
      pending.push({ kind: 'text', value: ']' })
      for (let index = current.length - 1; index >= 0; index -= 1) {
        if (index < current.length - 1) pending.push({ kind: 'text', value: ',' })
        pending.push({ kind: 'value', value: current[index] })
      }
    } else {
      const keys = Object.keys(current)
      output.push('{')
      pending.push({ kind: 'text', value: '}' })
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]
        if (index < keys.length - 1) pending.push({ kind: 'text', value: ',' })
        pending.push({ kind: 'value', value: current[key] })
        pending.push({
          kind: 'text',
          value: `${key === '__proto__' ? `[${JSON.stringify(key)}]` : JSON.stringify(key)}:`,
        })
      }
    }
  }
  return output.join('')
}

function isIdentifierName(name) {
  return /^(?:[$_]|\p{ID_Start})(?:[$_\u200C\u200D]|\p{ID_Continue})*$/u.test(name)
}

function toolMemberCode(name) {
  return isIdentifierName(name) ? `tools.${name}` : `tools[${JSON.stringify(name)}]`
}

function nativeCallCode(name, rawArgs, parsedArgs) {
  const argumentCode = jsonContainerDepth(parsedArgs) > MAX_DIRECT_LITERAL_DEPTH
    ? `JSON.parse(${JSON.stringify(rawArgs)})`
    : containsOwnProto(parsedArgs) ? safeJsonLiteral(parsedArgs) : rawArgs
  return `{\n  return await ${toolMemberCode(name)}(${argumentCode})\n}`
}

function acceptsTransportView(tools, editToolName) {
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > 2) return false
  const names = tools.map(tool => tool?.name)
  if (new Set(names).size !== names.length || !names.includes('run_code')) return false
  return names.every(name => name === 'run_code' || name === editToolName)
}

function resolveCandidateName(name, nativeSchemas) {
  if (typeof name !== 'string' || name.length === 0) return undefined
  const matches = new Set()
  if (nativeSchemas.has(name)) matches.add(name)
  if (name.startsWith('tools.')) {
    const member = name.slice('tools.'.length)
    if (member.length > 0 && !member.includes('.') && nativeSchemas.has(member)) {
      matches.add(member)
    }
  }
  return matches.size === 1 ? matches.values().next().value : undefined
}

function extractCall(chunks, index) {
  let name
  let id
  let deltaArgs = ''
  let finalArgs
  let deltaIndex = -1
  let invalidId = false
  let inconsistent = false
  let complete = false
  for (let position = 0; position < chunks.length; position += 1) {
    const chunk = chunks[position]
    if (chunk.index !== index) continue
    if (chunk.type === 'tool-call-delta') {
      if (chunk.id === undefined) invalidId = true
      else if (chunk.id !== '') {
        if (id !== undefined && id !== chunk.id) inconsistent = true
        else id = chunk.id
      }
      if (typeof chunk.name === 'string' && chunk.name.length > 0) {
        if (name !== undefined && name !== chunk.name) inconsistent = true
        else name = chunk.name
      }
      if (typeof chunk.argumentsDelta !== 'string') inconsistent = true
      else deltaArgs += chunk.argumentsDelta
      if (deltaIndex < 0) deltaIndex = position
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
      const block = chunk.block
      complete = true
      if (typeof block.id !== 'string' || block.id.length === 0) invalidId = true
      else if (id !== undefined && id !== block.id) inconsistent = true
      else id ??= block.id
      if (name !== undefined && name !== block.name) inconsistent = true
      else name ??= block.name
      if (typeof block.arguments !== 'string') inconsistent = true
      else if (finalArgs !== undefined && finalArgs !== block.arguments) inconsistent = true
      else finalArgs = block.arguments
    }
  }
  let args = deltaArgs
  if (finalArgs !== undefined) {
    if (deltaArgs.length > 0) {
      const streamed = parseArguments(deltaArgs)
      const finalized = parseArguments(finalArgs)
      if (!streamed.ok || !finalized.ok || !jsonValuesEqual(streamed.value, finalized.value)) {
        inconsistent = true
      }
    }
    args = finalArgs
  }
  return { name, id, args, deltaIndex, invalidId, inconsistent, complete }
}

function transformedChunks(chunks, replacements) {
  const byIndex = new Map(replacements.map(replacement => [replacement.index, replacement]))
  const emitted = new Set()
  return chunks.flatMap(chunk => {
    if (chunk.type === 'finish') {
      const { replayState: _replayState, ...finish } = chunk
      return [finish]
    }
    const replacement = byIndex.get(chunk.index)
    if (replacement === undefined) return [chunk]
    if (chunk.type === 'block-start') return [{ ...chunk, blockType: 'tool-call' }]
    if (chunk.type === 'tool-call-delta') {
      if (emitted.has(chunk.index)) return []
      emitted.add(chunk.index)
      return [{
        ...chunk,
        name: 'run_code',
        argumentsDelta: replacement.arguments,
      }]
    }
    if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
      return [{
        ...chunk,
        block: {
          type: 'tool-call',
          id: replacement.id,
          name: 'run_code',
          arguments: replacement.arguments,
        },
      }]
    }
    return [chunk]
  })
}

function transformCandidate(chunks, index, nativeSchemas, allowDeltaOnly) {
  const call = extractCall(chunks, index)
  const nativeName = resolveCandidateName(call.name, nativeSchemas)
  if ((!call.complete && !allowDeltaOnly) || nativeName === undefined
    || call.id === undefined || call.invalidId
    || call.inconsistent || call.deltaIndex < 0) return undefined
  const parsed = parseArguments(call.args)
  if (!parsed.ok) return undefined
  const argumentsValue = JSON.stringify({
    code: nativeCallCode(nativeName, call.args, parsed.value),
    description: `Call ${nativeName} inside the session REPL`,
  })
  return { index, id: call.id, arguments: argumentsValue }
}

function transformCandidates(chunks, indices, nativeSchemas, allowDeltaOnly = false) {
  const replacements = [...indices].map(index => transformCandidate(
    chunks, index, nativeSchemas, allowDeltaOnly,
  ))
    .filter(replacement => replacement !== undefined)
  return replacements.length === 0 ? undefined : transformedChunks(chunks, replacements)
}

/**
 * Normalize model-emitted native calls into the code-only direct-tool projection without guessing.
 * Unknown or malformed calls pass through unchanged for the host to diagnose.
 */
export async function* canonicalizeToolCallStream(source, options = {}) {
  const editToolName = typeof options.editToolName === 'string' && options.editToolName.length > 0
    ? options.editToolName
    : undefined
  if (options.enabled === false || !acceptsTransportView(options.tools, editToolName)) {
    yield* source
    return
  }
  const nativeSchemas = options.nativeSchemas instanceof Map
    ? new Map([...options.nativeSchemas].filter(([name]) => name !== 'run_code' && name !== editToolName))
    : new Map()
  if (nativeSchemas.size === 0) {
    yield* source
    return
  }
  const passthrough = new Set()
  const open = new Set()
  let pending = []
  let changed = false
  try {
    for await (const chunk of source) {
      if (pending.length > 0) {
        pending.push(chunk)
        if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') open.add(chunk.index)
        if (chunk.type === 'tool-call-delta'
          && resolveCandidateName(chunk.name, nativeSchemas) !== undefined) open.add(chunk.index)
        if (chunk.type === 'tool-call-delta' && open.size === 1 && open.has(chunk.index)
          && typeof chunk.name === 'string'
          && resolveCandidateName(chunk.name, nativeSchemas) === undefined) {
          yield* pending
          pending = []
          passthrough.add(chunk.index)
          open.clear()
        } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
          open.delete(chunk.index)
          if (open.size > 0) continue
          const indices = new Set(pending
            .filter(item => item.type === 'tool-call-delta' || item.type === 'block-end')
            .map(item => item.index))
          const transformed = transformCandidates(pending, indices, nativeSchemas)
          if (transformed === undefined) yield* pending
          else {
            changed = true
            yield* transformed
          }
          pending = []
        } else if (chunk.type === 'finish') {
          const indices = new Set(pending
            .filter(item => item.type === 'tool-call-delta' || item.type === 'block-end')
            .map(item => item.index))
          const transformed = transformCandidates(pending, indices, nativeSchemas, true)
          if (transformed !== undefined) {
            changed = true
            yield* transformed
          } else if (changed && Object.hasOwn(chunk, 'replayState')) {
            const { replayState: _replayState, ...finish } = chunk
            pending[pending.length - 1] = finish
            yield* pending
          } else {
            yield* pending
          }
          pending = []
          open.clear()
        }
        continue
      }
      if (passthrough.has(chunk.index)) {
        yield chunk
        if (chunk.type === 'block-end') passthrough.delete(chunk.index)
        continue
      }
      if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') {
        open.add(chunk.index)
        pending = [chunk]
      } else if (chunk.type === 'tool-call-delta'
        && resolveCandidateName(chunk.name, nativeSchemas) !== undefined) {
        open.add(chunk.index)
        pending = [chunk]
      } else if (changed && chunk.type === 'finish') {
        // Provider replay metadata describes the original response and becomes
        // stale only when at least one block was normalized.
        const { replayState: _replayState, ...finish } = chunk
        yield finish
      } else {
        yield chunk
      }
    }
  } catch (error) {
    yield* pending
    throw error
  }
  yield* pending
}
