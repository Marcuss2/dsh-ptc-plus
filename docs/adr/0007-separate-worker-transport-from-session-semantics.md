# Separate Worker Transport From Session Semantics

## Problem

The session runtime coordinates two different lifecycles: transport ownership for a worker, private message port, stderr tail, termination, and scratch directory; and REPL semantics for cell settlement, durability, journal replay, host binding calls, diagnostics, and checkpoints. Keeping both in `SessionKernel` made transport faults mutate semantic state through shared fields and duplicated policy facts across the host analyzer and worker.

## Decision

[`internal/worker-client.js`](../../internal/worker-client.js) exclusively owns worker creation, the readiness handshake, the private port, bounded stderr capture, reset, concurrent termination tracking, scratch allocation, and scratch cleanup. It reports private-channel messages and terminal failures through callbacks. [`internal/session-runtime.js`](../../internal/session-runtime.js) owns the active cell and decides how a reported message or failure settles the journal, durability state, replay transaction, or binding call. Messages reach the kernel only from the client's current worker, while each active semantic transaction retains its worker identity for lease and replay checks.

Cross-process policy that must agree on both sides has one source. [`internal/module-policy.js`](../../internal/module-policy.js) defines durable imports, forbidden kernel-control imports, and ambient globals for both static analysis and the worker runtime. [`internal/failure-reporting.js`](../../internal/failure-reporting.js) defines hostile-error normalization, active-cell stack extraction, bounded diagnostic logs, and repeat-failure tracking for the host and worker. Session-log recovery belongs to [`internal/session-journal.js`](../../internal/session-journal.js), which owns journal shape, event association, and branch folding. Live durable nodes, current-call exclusion, no-op confirmations, recovery boundaries, and cold nodes all use persisted `tool/call.seq` identity. During live dispatch, the journal owner uses `callId` only to resolve the unique unpaired top-level call, then passes its sequence into semantic state. Sessionless direct runtime calls do not fabricate a persisted identity. Journal v3 stores confirmed no-ops as sequences; v2 journals with empty confirmations migrate without ambiguity, while a v2 call-id confirmation forms an unknown suffix. A failed durable replay appends one log-only `ptc-plus/recovery-boundary` through the public `Session.append()` contract; its payload identifies the failed call event and its parent frontier. Every boundary is normalized as it enters recovery, before its event sequence participates in ordering; malformed boundary data therefore rejects reconstruction instead of disappearing from the fold. A completed record enters branch folding at its `tool/result` event position because that event confirms durability. Folding leaves immutable call/result events intact, removes the failed node and dependent descendants, and recomputes checkpoints from the remaining records. [`internal/session-runtime.js`](../../internal/session-runtime.js) resets the worker and retries the contracted frontier, recursively reaching the empty REPL only if every earlier candidate also fails.

## Alternatives considered

**Keep transport inside `SessionKernel`.** This avoids a class and callback pair, but leaves process handles, temporary filesystem state, private protocol setup, replay semantics, and journal settlement in one long-lived object. Transport tests then depend on semantic internals such as direct worker and port field mutation.

**Move message interpretation into the client.** The client could validate the whole private protocol, but `done`, `call`, `volatile`, and `output-limit` messages depend on the active journal, replay transcript, binding lease, output budget, and durability state. Moving those decisions would duplicate semantic state across two owners.

**Give each cell a new worker.** Per-cell workers simplify cancellation and failure isolation, but destroy live binding continuity and require source or state transport between cells, contrary to the session-bound REPL contract.

**Keep duplicated module and failure helpers near each consumer.** Local copies reduce imports, but policy drift can make static durability classification disagree with runtime behavior, and error normalization differences make worker and host failures observably inconsistent.

**Mutate or replace the persisted result after replay failure.** A session exposes immutable event snapshots and an append-only public write path; rewriting a result either fails against frozen data or bypasses the session's persistence and publication contract. A dedicated log-only boundary preserves the original evidence and makes the contraction replayable.

**Locate a replay result by journal equality.** Journals encode replay semantics rather than event identity, so unrelated cells may have identical journals. Call identity and `sourceEventSeqs` select the exact result without conflating equal content with log position.

**Use `callId` as the recovery-boundary identity.** Provider call IDs correlate calls and results but are not guaranteed to be unique across a session. Persisted event sequences identify exact log records and remain stable when a provider reuses an ID.

**Keep call-id confirmations for legacy compatibility.** Dual identity would require every recovery branch to choose which identifier is authoritative and would preserve the ambiguity that caused durable history loss. The decoder instead accepts only the legacy subset whose empty confirmation list needs no association.

**Resolve the event identity only after replay fails.** Delayed lookup occurs after later calls and results may have entered the log, making reused IDs or incomplete associations ambiguous. Capturing the current unpaired call at dispatch preserves the identity already established by DSH's append-before-dispatch lifecycle.

**Always recover from an empty REPL.** This guarantees a clean worker but discards verified bindings and checkpoints unnecessarily. Parent-by-parent contraction retains the largest frontier whose replay actually succeeds.

**Compare raw boundary sequences before decoding boundary events.** This appears to avoid work for boundaries after the current record, but an absent or nonnumeric sequence is not orderable and can evade the decoder entirely. Normalizing at session-log ingestion gives the fold one trusted boundary shape and makes damaged history fail closed.

## Consequences

Worker resource cleanup and startup failures are independently testable, while the kernel retains one owner for journal and replay meaning. The client callback is deliberately narrow: it carries transport facts, not journal decisions. Recovery writes one additional non-surface session event and does not change tool schemas, model messages, truthful top-level tool identity, `edit_run_code`, or recorded-value replay. Adding a private protocol message still requires a kernel handler and contract tests because the client does not interpret semantic payloads. Shared policy modules become load-bearing single sources and must remain usable in both the main thread and worker without importing session state.
