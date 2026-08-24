import {
  JOURNAL_KEY,
  normalizeDerivedEditResult,
  normalizeJournal,
  validatedRewrites,
} from './session-journal.js'

const RUN_CODE = 'run_code'
const EDIT_RUN_CODE = 'edit_run_code'
const SYSTEM_PROMPT_PLUGIN = '@deepseek-ai/dsh-system-prompt'

function systemPromptSnapshot(event, index, contextStep) {
  const source = event?.data?.source
  if (event?.type !== 'user/message' || source?.kind !== 'plugin'
    || source.plugin !== SYSTEM_PROMPT_PLUGIN || source.form !== 'snapshot'
    || !Array.isArray(source.sections)) return undefined
  const names = new Set()
  const sections = []
  for (const section of source.sections) {
    if (section === null || typeof section !== 'object' || Array.isArray(section)
      || typeof section.name !== 'string' || section.name.length === 0
      || typeof section.text !== 'string' || names.has(section.name)) return undefined
    names.add(section.name)
    sections.push(Object.freeze({ name: section.name, text: section.text }))
  }
  return Object.freeze({ index, contextStep, sections: Object.freeze(sections) })
}

function parsedRun(call, result, index) {
  let args
  let journal
  try {
    const parsed = JSON.parse(call.data.arguments)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args = Object.freeze(parsed)
    }
  } catch {
    // Invalid persisted arguments cannot support any derived prompt fact.
  }
  try {
    journal = normalizeJournal(result.data?.meta?.[JOURNAL_KEY])
  } catch {
    // Invalid journal metadata remains unknown.
  }
  const rewrites = validatedRewrites(result.data?.meta)
  return Object.freeze({
    index,
    callSeq: Number.isSafeInteger(call.seq) ? call.seq : undefined,
    args,
    source: typeof args?.code === 'string' ? args.code : undefined,
    journal,
    rewrites,
  })
}

function parsedDerivedRun(call, result, index, target) {
  let derived
  try { derived = normalizeDerivedEditResult(result?.data?.meta, target?.callSeq) } catch { return undefined }
  return Object.freeze({
    index,
    callSeq: Number.isSafeInteger(call.seq) ? call.seq : undefined,
    args: Object.freeze({ description: derived.description }),
    source: derived.code,
    journal: derived.journal,
    rewrites: validatedRewrites(result?.data?.meta),
  })
}

function isContextStep(event) {
  return event?.type === 'request/header'
    || event?.type === 'assistant/message'
    || (event?.type === 'user/message' && event.data?.source?.kind === 'user')
}

function targetSnapshot(target) {
  if (target?.source === undefined || target.callSeq === undefined) return undefined
  return Object.freeze({ source: target.source, callSeq: target.callSeq })
}

/** Project session events into immutable facts consumed by prompt presentation. */
export function projectSessionLog(agent, requestedEdit) {
  const events = agent?.session?.events
  if (!Array.isArray(events)) {
    return Object.freeze({
      openTurn: false,
      contextStep: 0,
      systemPromptSnapshots: Object.freeze([]),
      lastSuccessfulRunIndex: undefined,
      latestRun: undefined,
      editableRun: undefined,
      repairSource: undefined,
    })
  }
  let openTurn = false
  let contextStep = 0
  let lastSuccessfulRunIndex
  let latestRun
  let editableRun
  let requestedEditTarget
  const calls = new Map()
  const claimedEditTargets = new Set()
  const seenCallIds = new Set()
  const systemPromptSnapshots = []
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    const snapshot = systemPromptSnapshot(event, index, contextStep)
    if (snapshot !== undefined) systemPromptSnapshots.push(snapshot)
    if (isContextStep(event)) contextStep += 1
    if (event?.type === 'turn/start') {
      openTurn = true
      calls.clear()
      claimedEditTargets.clear()
      seenCallIds.clear()
      latestRun = undefined
      editableRun = undefined
      continue
    }
    if (event?.type === 'turn/end') {
      openTurn = false
      calls.clear()
      claimedEditTargets.clear()
      seenCallIds.clear()
      latestRun = undefined
      editableRun = undefined
      continue
    }
    if (!openTurn) continue
    if (event?.type === 'tool/call' && typeof event.data?.callId === 'string') {
      if (event.data.name === EDIT_RUN_CODE
        && requestedEdit?.callId === event.data.callId && requestedEdit.callSeq === event.seq) {
        const targetCallSeq = editableRun?.callSeq
        requestedEditTarget = targetCallSeq !== undefined && !claimedEditTargets.has(targetCallSeq)
          ? targetSnapshot(editableRun)
          : undefined
      }
      if (seenCallIds.has(event.data.callId)) calls.set(event.data.callId, null)
      else {
        seenCallIds.add(event.data.callId)
        let editTarget
        let claimedEditTarget
        if (event.data.name === EDIT_RUN_CODE) {
          editTarget = editableRun
          const targetCallSeq = editTarget?.callSeq
          if (targetCallSeq !== undefined && !claimedEditTargets.has(targetCallSeq)) {
            claimedEditTargets.add(targetCallSeq)
            claimedEditTarget = targetCallSeq
          } else {
            editTarget = undefined
          }
        }
        calls.set(event.data.callId, {
          call: event,
          editTarget,
          claimedEditTarget,
        })
      }
      continue
    }
    if (event?.type !== 'tool/result') continue
    const callId = event.data?.message?.source?.callId
    const pending = typeof callId === 'string' ? calls.get(callId) : undefined
    if (typeof callId === 'string') calls.delete(callId)
    if (pending === null) {
      latestRun = undefined
      editableRun = undefined
      continue
    }
    const call = pending?.call
    if (call?.data?.name === EDIT_RUN_CODE) {
      const derived = parsedDerivedRun(call, event, index, pending.editTarget)
      if (derived === undefined && pending.claimedEditTarget !== undefined) {
        claimedEditTargets.delete(pending.claimedEditTarget)
      }
      if (derived !== undefined) {
        latestRun = derived
        editableRun = derived
        if (derived.journal?.completion?.kind === 'return' && derived.journal.status !== 'noop') {
          lastSuccessfulRunIndex = index
        }
      }
      continue
    }
    if (call?.data?.name !== RUN_CODE) {
      latestRun = undefined
      continue
    }
    const run = parsedRun(call, event, index)
    latestRun = run
    editableRun = run
    if (run.journal?.completion?.kind === 'return' && run.journal.status !== 'noop') {
      lastSuccessfulRunIndex = index
    }
  }
  return Object.freeze({
    openTurn,
    contextStep,
    systemPromptSnapshots: Object.freeze(systemPromptSnapshots),
    lastSuccessfulRunIndex,
    latestRun,
    editableRun,
    repairSource: editableRun?.source,
    ...(requestedEdit === undefined ? {} : { requestedEditTarget }),
  })
}

/** Return the target snapshot captured at one persisted edit call event. */
export function editTargetForCall(agent, callId, callSeq) {
  if (typeof callId !== 'string' || callId.length === 0
    || !Number.isSafeInteger(callSeq) || callSeq < 0) return undefined
  return projectSessionLog(agent, { callId, callSeq }).requestedEditTarget
}
