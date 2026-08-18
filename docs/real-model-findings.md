# Real-model findings

This file retains only de-identified structural facts from opt-in Windows DSH
acceptance runs. Raw session logs, user text, absolute paths, credentials, model
prose, call ids, and timestamps are excluded.

## Program capability lifted into the tool plane

A strict PTC session exposed only `run_code`, yet the model twice emitted an
outer tool call named `host.invoke`. The inner calls targeted currently available
`skill` and `todo_write` capabilities. Both outer calls failed with
`UNKNOWN_TOOL`; later cells used ordinary `run_code` successfully.

This is a presentation error rather than an ambiguous intent error. The exact
JSON value already contains the program call's `name` and `args`, so it can be
converted before assistant-message persistence to:

```ts
{
  // PTC Plus kept this program capability inside the session REPL.
  const __ptcArgs = JSON.parse("...")
  return await host.invoke(__ptcArgs)
}
```

The regression fixture is
[`test/fixtures/model-tool-call-antipatterns.json`](../test/fixtures/model-tool-call-antipatterns.json).
It preserves only outer name, inner name, argument-key shape, and result code.

## General rule

Canonicalization is allowed only before DSH persists the assistant stream, and
only when the current scoped schema proves that a native target exists or a
closed PTC program contract proves the lifted call shape. Unknown names and
malformed program calls remain unchanged. A successful rewrite drops opaque
provider replay state so the normalized assistant message is the only replay
fact.
