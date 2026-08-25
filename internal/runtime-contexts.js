import { latestRecoveryTip } from './recovery-tips.js'
import { projectSessionLog } from './session-log-view.js'

const REWRITE_FEEDBACK = 'tools:ptc-plus-rewrite-info'
const CORDIS_RECOVERY = 'tools:ptc-plus-cordis-recovery'
const CORDIS_RECOVERY_TEXT = 'Recorded Cordis values in the recovered REPL are historical data, not proof that process-local Plugins, Runs, approvals, or Inspect observations still exist in the current DSH process. Before relying on prior Cordis IDs, state, or capability data, follow the current Cordis owner guidance and call the live read-only Cordis Inspect bindings through `tools.*`; do not rerun mutating Cordis calls merely to reconstruct history.'

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
  return undefined
}

/** Build all dynamic PTC contexts from one session-log projection. */
export function sessionRuntimeContexts(agent, tipConfig, options = {}) {
  const view = projectSessionLog(agent)
  const rewrite = continuationFeedback(view)
  const tip = latestRecoveryTip(view, tipConfig)
  const cordisRecovery = options.cordisRecoveryRequired?.(view) === true
    ? { name: CORDIS_RECOVERY, text: CORDIS_RECOVERY_TEXT }
    : undefined
  return Object.freeze({
    contexts: Object.freeze([
      ...(rewrite === undefined ? [] : [{ name: REWRITE_FEEDBACK, text: rewrite }]),
      ...(cordisRecovery === undefined ? [] : [cordisRecovery]),
      ...(tip === undefined ? [] : [tip]),
    ]),
  })
}
