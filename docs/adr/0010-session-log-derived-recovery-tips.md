# Add Fatigue-Aware Recovery Tips

## Problem

The persistent REPL contract must stay short enough for every request, while some failures need a model-visible recovery affordance. Repeated binding failures and platform-specific command errors benefit from a precise next action. A real `edit_run_code` call already carries its identity, arguments, and result; restating those facts in a runtime context wastes tokens and causes DSH to append a new aggregate snapshot containing unrelated contributions. Long failed cells are a separate trigger: after the failure is persisted, a bounded context may distinguish a journal-proven no-execution edit candidate from a possibly effectful failure.

## Decision

PTC Plus keeps the stable REPL guidance limited to invariants, discovery entry points, and environment-neutral boundaries. `internal/session-log-view.js` scans the event sequence once, pairs settled calls within each open turn, validates execution journals and rewrite records once, and returns immutable facts for edit targeting, successful-run reset, context distance, and canonical DSH system-prompt snapshots. Each snapshot preserves its named sections. `internal/runtime-contexts.js` renders rewrite feedback only when the rewritten cell failed or lacks a valid journal, plus at most one context from the reserved `tools:ptc-plus-tip/<trigger>/<ordinal>` name family. Successful transparent rewrites remain result metadata and do not create aggregate snapshot churn. It never emits edit provenance or target-lifecycle context: those facts belong to the registered tool call/result and its private derived-execution metadata. Tips never change the tool list, tool schemas, or system sections.

The default triggers are a repeated binding failure and a failure whose diagnostic or structured cause identifies an executable, shell, or path problem. The first tip is concise. A matching trigger may produce another tip only after `tipCooldownMessages` model-context steps; unresolved matching tips reach the detailed form after `tipEscalationFailures` occurrences. A successful cell resets the unresolved escalation count. Every emitted tip name carries its stable trigger identity and next per-trigger ordinal. Reconstruction accepts only canonical snapshots from DSH's system-prompt owner, treats a named section as one effective-state transition even when another owner's aggregate update repeats it, and ignores legacy or malformed plugin prose. Visible wording does not determine cooldown or escalation identity.

Platform wording names execution-world differences without assuming Windows, WSL, POSIX, a shell, or package-runner availability. `edit_run_code` remains independently available as a fixed real tool and does not depend on a recovery-tip trigger.

## Alternatives considered

- **Keep all recovery instructions in the stable system prompt.** This makes every request pay for rare failures and makes platform-specific text look universally applicable.
- **Emit a tip after every matching failure.** This repeats stale advice, consumes context, and can encourage blind retry loops.
- **Store mutable tip counters only in the kernel.** A worker restart or replay would then change model-visible behavior without a session-log source.
- **Infer tip identity from rendered prose or one fixed section name.** Wording changes would reset history, unrelated plugin text could create false matches, and an unchanged aggregate context would not persist repeated occurrences.
- **Change the available tools when a tip is needed.** This would break the fixed code-only direct-tool prefix and make failure state observable through schema churn.
- **Let each runtime-context renderer scan the event log.** Independent scans duplicate parsing and can disagree about call/result pairing, turn boundaries, repair consumption, or successful-run resets. A shared projection keeps event interpretation separate from presentation policy.

## Consequences

Normal requests receive only the persistent REPL invariants in stable system text. Prompt assembly performs one linear event projection regardless of how many PTC runtime contexts consume it; renderers receive facts rather than raw history or search callbacks. Failure recovery becomes an append-only, bounded context contribution with explicit cooldown and escalation semantics. Changing a tip's name records a new effective context even when compact wording repeats, while aggregate snapshots that repeat the same named section do not advance fatigue state. Tip wording and thresholds are configurable, but their defaults remain conservative; disabling tips removes only the runtime context and does not remove `edit_run_code` or any native capability.
