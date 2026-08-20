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

function nativeCallCode(name, rawArgs) {
  return `{
  const __ptcArgs = JSON.parse(${JSON.stringify(rawArgs)})
  return await tools[${JSON.stringify(name)}](__ptcArgs)
}`
}

export const EDIT_RUN_CODE_REJECTION_DESCRIPTION = 'Reject unavailable run_code edit'
export const EDIT_RUN_CODE_EXECUTION_DESCRIPTION = 'Edit and run rejected TypeScript cell'

function rejectedEditArguments(reason) {
  return JSON.stringify({
    code: `return ${JSON.stringify({ edited: false, reason })}`,
    description: EDIT_RUN_CODE_REJECTION_DESCRIPTION,
  })
}

function editRunCodeArguments(value, repairSource) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return rejectedEditArguments('edit_run_code expects old_string and new_string strings')
  }
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('old_string') || !keys.includes('new_string')
    || typeof value.old_string !== 'string' || typeof value.new_string !== 'string') {
    return rejectedEditArguments('edit_run_code expects exactly old_string and new_string strings')
  }
  if (value.old_string.length === 0) {
    return rejectedEditArguments('old_string must be non-empty')
  }
  if (value.old_string === value.new_string) {
    return rejectedEditArguments('old_string and new_string must differ')
  }
  if (repairSource === undefined) {
    return rejectedEditArguments('no run_code cell is currently eligible for safe editing')
  }
  const first = repairSource.indexOf(value.old_string)
  if (first < 0) return rejectedEditArguments('old_string was not found in the rejected cell')
  if (repairSource.indexOf(value.old_string, first + value.old_string.length) >= 0) {
    return rejectedEditArguments('old_string occurs more than once in the rejected cell')
  }
  const code = repairSource.slice(0, first) + value.new_string
    + repairSource.slice(first + value.old_string.length)
  return JSON.stringify({ code, description: EDIT_RUN_CODE_EXECUTION_DESCRIPTION })
}

function acceptsTransportView(tools, editToolName) {
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > 2) return false
  const names = tools.map(tool => tool?.name)
  if (new Set(names).size !== names.length || !names.includes('run_code')) return false
  return names.every(name => name === 'run_code' || name === editToolName)
}

function isCandidateName(name, nativeSchemas, editToolName, editVisible) {
  return (editVisible && name === editToolName) || nativeSchemas.has(name)
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

function transformCandidate(chunks, index, nativeSchemas, editToolName, editVisible, repairSource, allowDeltaOnly) {
  const call = extractCall(chunks, index)
  if ((!call.complete && !allowDeltaOnly) || !isCandidateName(call.name, nativeSchemas, editToolName, editVisible)
    || call.id === undefined || call.invalidId
    || call.inconsistent || call.deltaIndex < 0) return undefined
  const parsed = parseArguments(call.args)
  if (!parsed.ok) return undefined
  const editing = editVisible && call.name === editToolName
  const argumentsValue = editing
    ? editRunCodeArguments(parsed.value, repairSource)
    : JSON.stringify({
        code: nativeCallCode(call.name, call.args),
        description: `Call ${call.name} inside the session REPL`,
      })
  return { index, id: call.id, arguments: argumentsValue }
}

function transformCandidates(
  chunks, indices, nativeSchemas, editToolName, editVisible, repairSource, allowDeltaOnly = false,
) {
  const replacements = [...indices].map(index => transformCandidate(
    chunks, index, nativeSchemas, editToolName, editVisible, repairSource, allowDeltaOnly,
  ))
    .filter(replacement => replacement !== undefined)
  return replacements.length === 0 ? undefined : transformedChunks(chunks, replacements)
}

/**
 * Normalize model-emitted native calls into strict Code Mode without guessing.
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
  const editVisible = editToolName !== undefined && options.tools.some(tool => tool?.name === editToolName)
  const repairSource = typeof options.repairSource === 'string' ? options.repairSource : undefined
  const nativeSchemas = options.nativeSchemas instanceof Map
    ? new Map([...options.nativeSchemas].filter(([name]) => name !== 'run_code'))
    : new Map()
  if (nativeSchemas.size === 0 && !editVisible) {
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
          && isCandidateName(chunk.name, nativeSchemas, editToolName, editVisible)) open.add(chunk.index)
        if (chunk.type === 'tool-call-delta' && open.size === 1 && open.has(chunk.index)
          && typeof chunk.name === 'string'
          && !isCandidateName(chunk.name, nativeSchemas, editToolName, editVisible)) {
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
          const transformed = transformCandidates(
            pending, indices, nativeSchemas, editToolName, editVisible, repairSource,
          )
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
          const transformed = transformCandidates(
            pending, indices, nativeSchemas, editToolName, editVisible, repairSource, true,
          )
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
        && isCandidateName(chunk.name, nativeSchemas, editToolName, editVisible)) {
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
