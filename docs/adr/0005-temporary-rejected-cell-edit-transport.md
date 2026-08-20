# Use A Rejected-Cell Edit Transport As A Temporary Affordance

A small syntax or binding error in a long `run_code` cell should not force the model to emit the
entire source again. PTC Plus therefore exposes a second model-wire primitive with the same exact
string-edit shape used by familiar source editors:

```ts
edit_run_code({ old_string: string, new_string: string })
```

The target is the most recent `run_code` cell in the same open turn that the journal proves was
rejected before execution. Eligibility is limited to `noop` cells diagnosed with `PTC-C001`,
`PTC-C002`, or `PTC-N001`. A runtime failure, timeout, cancellation, partial execution, or unknown
effect is never eligible because rerunning it could duplicate effects.

Intervening inspection cells do not erase an eligible target: they cannot retroactively make the
rejected source execute, and the model could always resubmit that source as a new cell. The target is
consumed when a repaired cell actually executes. If the repaired source is itself rejected before
execution, that new rejected source becomes the latest eligible target.

The replacement is literal and deliberately narrow. `old_string` must be non-empty, differ from
`new_string`, and occur exactly once. There are no cell identifiers, line numbers, replace-all,
multi-patch payloads, diff syntax, automatic repair, or runtime retry. An unavailable target or an
invalid replacement returns `{ edited: false, reason }` through a successful `run_code` result and
does not create a PTC warning.

Every session-bound strict Code Mode request exposes `[run_code, edit_run_code]` in that order.
Target availability never changes the name, schema, order, or instruction, preserving provider
prompt and tool caching. `edit_run_code` is not registered as a DSH native tool. Before the assistant
message is persisted, PTC Plus deterministically reconstructs the complete source and lowers the
call to the official `run_code` transport. The complete repaired source remains visible in the
session log, and normal validation, execution, journal, and result projection remain authoritative.
The native registry name is reserved and a conflict fails assembly.

This is a transport affordance, not a second editor or metaprogramming DSL. Its purpose is only to
avoid full-source re-emission after a local pre-execution rejection. The target architecture is a
unified PTC and tool transport where an already-emitted structured program can be amended natively.
When that capability is available and reliable, remove this primitive instead of expanding it.
