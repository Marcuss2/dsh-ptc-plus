import { latestRecoveryTip } from './recovery-tips.js'
import { projectSessionLog } from './session-log-view.js'

const REWRITE_FEEDBACK = 'tools:ptc-plus-rewrite-info'

function continuationFeedback(view) {
  const run = view.latestRun
  const rewrites = run?.rewrites
  if (rewrites === undefined || rewrites.length === 0) return undefined
  const details = rewrites.map(rewrite => rewrite.description).join('; ')
  if (run.journal === undefined) {
    return `The preceding run_code cell had these source adjustments: ${details}. Its completion is unknown because no valid execution journal is available. Inspect its tool result and live bindings before continuing; do not assume it completed or failed, and do not replay it automatically.`
  }
  if (run.journal.completion?.kind !== 'return') {
    return `The preceding run_code cell failed after a source adjustment: ${details}. Treat it as failed; inspect its tool result and live bindings before continuing, and do not replay it automatically.`
  }
  return `The preceding run_code cell completed after these source adjustments: ${details}. Continue by reusing its ordinary top-level bindings; do not resend its source.`
}

/** Build all dynamic PTC contexts from one session-log projection. */
export function sessionRuntimeContexts(agent, tipConfig) {
  const view = projectSessionLog(agent)
  const rewrite = continuationFeedback(view)
  const tip = latestRecoveryTip(view, tipConfig)
  return Object.freeze({
    contexts: Object.freeze([
      ...(rewrite === undefined ? [] : [{ name: REWRITE_FEEDBACK, text: rewrite }]),
      ...(tip === undefined ? [] : [tip]),
    ]),
  })
}
