# dsh-ptc-plus

[![Node.js ^22.19.0 || >=24.0.0](https://img.shields.io/badge/Node.js-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-5fa04e?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-PTC%20mode-4b6bfb)](https://github.com/deepseek-ai/deepseek-harness)
[![Status: community plugin](https://img.shields.io/badge/Status-community%20plugin-lightgrey)](docs/publishing.md)

<p align="center">
  <img src="assets/dsh-ptc-plus-banner.webp" alt="dsh-ptc-plus banner">
</p>

**A session-bound, persistent TypeScript REPL for DeepSeek Harness PTC mode.** Variables, imports, and computed results from the last cell are still there in the next one — instead of starting from zero every time.

> [!NOTE]
> Community plugin — no affiliation with or endorsement from DeepSeek or DSH.

> [!IMPORTANT]
> Built for `danger-full-access`: direct Node.js and OS access with no extra sandbox. Use it only where that permission scope is acceptable.

## Why this exists

Every `run_code` in DSH PTC mode normally evaluates in a fresh environment. The model resends setup source it already computed, and after any mistake it resends the whole cell again. PTC Plus connects `run_code` to a persistent kernel that remembers its session, so later cells reuse bindings directly and repairs can transmit a delta instead of the complete source.

## Measured paired observation

One identity-blinded A/B run with `opencode-go/deepseek-v4-flash` compared PTC Plus against DSH PTC mode with PTC Plus disabled. Both arms used the same versioned fixture, task prompts, permissions, and two replicates per task, producing 18 sessions per arm:

| Across all 9 tasks | PTC Plus | DSH PTC mode (PTC Plus disabled) | Observed change |
| --- | ---: | ---: | ---: |
| Model requests | 66 | 88 | 25.0% fewer |
| Tool calls | 50 | 79 | 36.7% fewer |
| Token traffic | 729,642 | 942,901 | 22.6% fewer |
| Identity-blind rubric score | 138 / 162 | 118 / 162 | +12.3 percentage points |

The module-syntax task was the sharpest discriminator: PTC Plus completed both replicates with one `run_code` each, while DSH PTC mode without PTC Plus completed neither static-import requirement and used eight tool calls across its attempts.

This is one stochastic paired observation, not a performance guarantee or a release gate. Predefined machine budgets were exceeded in 2 of 18 PTC Plus sessions and 5 of 18 sessions without PTC Plus, so the matrix as a whole did not pass machine acceptance. Token traffic includes input, cache-read, cache-write, and output tokens. The fixture, pairing rules, metrics, and blind-review protocol are documented in [Evaluation](docs/evaluation.md).

## Highlights

### Misplaced top-level calls, silently rescued

If the model mistakenly dispatches at the top level a native tool that is known in the current live scope but not in the tool registration list, PTC Plus normalizes that invalid direct call into the equivalent `run_code` rather than spending a failed round:

```ts
// invalid direct call                        // normalized execution
goal({ session_id })                          await tools.goal({ session_id })
```

That normalization deliberately records the executable `run_code`, because the original call was outside the declared direct protocol. A valid `edit_run_code` is different: its name and delta arguments remain unchanged in history.

### State survives between calls

```ts
// first run_code
import { readFile } from 'node:fs/promises'
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const deps = Object.keys(manifest.dependencies ?? {})
return deps.length
```

```ts
// second run_code — everything from the first is still here
return deps.map(dep => `${dep}@${manifest.dependencies[dep]}`)
```

### Repair, don't resend

The most recent cell can be adjusted atomically after a rejection, failure, or successful-but-imperfect result: up to 16 exact replacements, or one bounded regex set, applied to its own source text.

```ts
edit_run_code({ edits: [{ old_string: 'deps.length', new_string: 'deps' }] })
```

The model sends a real `edit_run_code` call containing the diff, not the source. The derived source stays in private replay metadata instead of being duplicated into the next model context.

### And more

- **Durable work survives a restart** — the session log rebuilds replayable REPL state, falling back to the last verified frontier when later history cannot be recovered safely.
- **Named state checkpoints** — save, restore, list, and delete durable REPL states to branch an investigation without rebuilding its setup.
- **Project-relative execution** — relative imports, filesystem paths, and child processes use the recorded session working directory.
- **Rich JavaScript values stay intact** — transport and replay preserve `undefined`, special numbers, BigInt, sparse arrays, shared references, and cycles.
- **Module syntax, no workaround** — `import`/`export` are adapted automatically, with dependencies truly resolved from your project and imported bindings read-only. A cell that combines value imports with direct `eval` or `with` fails before module loading instead of running with altered name resolution.
- **Inspect before calling** — `capabilities.tree/find/inspect` describe the live typed tool surface: zero model calls, no elevated authority.
- **Output stays bounded** — logging is metered per run; a huge print is cut at budget instead of flooding the context, with stable error codes mapped back to your own source lines.
- **Agent-verifying host tools** — goal tracking and similar tools that require the calling agent are callable from within a run.

The three `auto*` rewrite switches (imports / exports / mixed redeclaration) are on by default and individually disableable.

![Rejected run_code and the follow-up edit_run_code repair](assets/ptc-plus-repair.png)

*A real session: the long code and the truthful `edit_run_code` repair call. The repair never resends the source.*

## Install

Requires Node.js `^22.19.0 || >=24.0.0` and DSH with TypeScript PTC mode:

```sh
dsh plugin --profile <profile> add github:muyuanjin/dsh-ptc-plus#main
dsh --profile <profile> --dump-config
```

Other install methods and compatibility details are in the [installation guide](docs/installation.md).

`danger-full-access` is the primary supported experience. The worker isolates lifecycle, not malicious code.

## Documentation

[Installation](docs/installation.md) · [Runtime reference](docs/runtime-reference.md) · [Architecture](docs/architecture.md) · [All docs](docs/README.md)

MIT licensed. See [LICENSE](LICENSE).
