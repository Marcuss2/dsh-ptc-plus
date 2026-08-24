# Persist Cell Rewrite Policy

## Problem

Durable replay prepares the original cell source again. AST module and REPL convenience rewrites are configuration-controlled, so using the current profile during replay can reject a cell that was durable when it was recorded. Replay would then discard recoverable bindings even though the journal still proves the cell's calls and completion.

## Decision

Journal version 3 records `rewritePolicy` beside `bindingMode` with the three boolean rewrite settings used to prepare the cell. Live journals capture the active profile; replay passes each node's recorded policy to `prepareProgram`. The policy is part of journal normalization and equality, is frozen with the journal, and is required by the closed schema. A profile change therefore affects only new cells; existing durable nodes retain the language policy under which they were evaluated.

The journal decoder also owns the predecessor adapters. Version 1 has its original closed field set and migrates with all three later rewrite switches disabled, matching the language pipeline that emitted it; `bindingMode` continues to preserve its top-level redeclaration policy. Its string call-ID confirmations become version 3 event sequences only when the enclosing session log contains exactly one earlier unjournaled `run_code` call with that identity. Missing or repeated candidates are ambiguous and fail closed. Version 2 already contains `rewritePolicy` and normalizes to version 3 only when its confirmed no-op list is absent or empty; version 2 call-ID confirmations remain unsupported.

## Alternatives considered

**Persist transformed source.** This would avoid rerunning the rewrite pass, but it duplicates generated code in the session log, makes source provenance less direct, and couples the durable protocol to an analyzer intermediate representation.

**Reject recovery when rewrite settings differ.** This preserves semantic caution, but throws away replayable history even when the original source and recorded policy are sufficient to reconstruct it.

**Read the current profile during replay.** This keeps the journal small, but makes durable recovery depend on mutable deployment configuration and causes valid historical cells to become unrecoverable after a configuration change.

**Accept every version 2 confirmation by call ID.** Preserving those values would require replay to guess which event a reused provider call ID denotes. Only the empty-confirmation subset has an identity-independent meaning, so broader migration would weaken the version 3 event-sequence contract owned by [ADR 0007](0007-separate-worker-transport-from-session-semantics.md).

## Consequences

The current journal schema is version 3. Replay remains source-based and deterministic while configuration changes no longer invalidate durable cells. Version 1 histories retain the predecessor language behavior and migrate only uniquely identified confirmations; version 2 histories without call-ID confirmations retain their recorded rewrite policy. Ambiguous identity remains unsupported recovery input rather than receiving guessed defaults. New profile settings apply at the next live cell boundary.
