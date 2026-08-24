---
schema: dsh-review-findings/v3
ledgerStatus: open
findings:
  - id: F001
    severity: P1
    status: unresolved
    dispositionRef:
    owner: path/to/canonical-owner
    condition: >-
      State the smallest reproducible condition.
    impact: >-
      State the observable correctness, safety, or maintainability consequence.
    requiredOutcome: >-
      State the invariant or behavior that must hold after resolution.
    implementationPlan:
    resolutionEvidence:
---
# Review Findings

This local ledger records actionable review findings. Keep one entry per independent root cause. `requiredOutcome` is the stable acceptance condition. Once a concrete correction is chosen, record the current canonical-owner changes, dependent artifacts, and discriminating verification in `implementationPlan` before editing the fix; update it before continuing whenever the plan changes. Add factual progress and verification to `resolutionEvidence` without turning the ledger into a chronological transcript.

Finding statuses are `unresolved`, `resolved`, `invalid`, or `accepted`. Every terminal status requires evidence sufficient for a future maintainer to verify the disposition, `resolved` also requires a non-empty `implementationPlan`, and `accepted` requires `dispositionRef` to name the tracked document or external issue that owns the retained limitation. Other statuses leave `dispositionRef` empty. Set `ledgerStatus` to `resolved` only after every finding is terminal.
