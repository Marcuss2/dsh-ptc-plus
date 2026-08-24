# dsh-ptc-plus

[![Node.js ^22.19.0 || >=24.0.0](https://img.shields.io/badge/Node.js-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-5fa04e?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-PTC%20mode-4b6bfb)](https://github.com/deepseek-ai/deepseek-harness)
[![Status: community plugin](https://img.shields.io/badge/Status-community%20plugin-lightgrey)](docs/publishing.md)

<p align="center">
  <img src="assets/dsh-ptc-plus-banner.webp" alt="dsh-ptc-plus banner">
</p>

**PTC Plus gives DSH PTC mode a session-bound persistent TypeScript REPL.** Every `run_code` continues in the same session. Variables, imports, and results from one `run_code` are still available in the next one.

> [!NOTE]
> Community plugin, no affiliation with or endorsement from DeepSeek or DSH.

> [!IMPORTANT]
> Built for `danger-full-access`: direct Node.js and OS access with no extra sandbox. Use it only where that permission scope is acceptable.

![PTC Plus settings card](assets/ptc-plus-settings.png)

*The settings card exposes live configuration and the `enabled` kill switch.*

## What default PTC mode gets wrong

DSH PTC mode starts every `run_code` in a fresh environment. The model computes something, then has to send the same setup code again. One bad line means the whole thing is resent. This plugin attaches `run_code` to a session-backed environment, so later calls reuse what was already there.

| Situation | Default PTC mode | With PTC Plus |
| --- | --- | --- |
| State | starts from zero, setup resent ❌ | previous `run_code` results stay ✅ |
| Fixing | wrong result resends the code ❌ | one diff ✅ |
| Modules | `import` / `export` cannot be written ❌ | written normally, AST handles it ✅ |
| Values | JSON changes or loses special values ❌ | those values stay intact ✅ |
| Restart | everything is lost ❌ | recoverable parts come back ✅ |
| Output and errors | printing floods, errors point elsewhere ❌ | output trimmed, errors map to your line ✅ |
| Tools | list invisible, miscalls fail ❌ | can inspect; known miscalls become `run_code` ✅ |
| Paths | relative paths can drift ❌ | session remembers the project directory ✅ |
| Agent tools | tools needing the agent are rejected ❌ | context restored, goal works ✅ |

## Three scenes that matter most

### State carries over

First `run_code`:

```ts
import { readFile } from 'node:fs/promises'
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const deps = Object.keys(manifest.dependencies ?? {})
return deps.length
```

The next one keeps going:

```ts
return deps.map(dep => dep + '@' + manifest.dependencies[dep])
```

`deps` and `manifest` are still there. The setup code is sent only once.

### Fix without resending

By default, a wrong result or a failure sends the whole code block again.

With PTC Plus, it sends one line:

```ts
edit_run_code({ edits: [{ old_string: 'deps.length', new_string: 'deps' }] })
```

Only the diff goes in. The full source stays out of the conversation. Exact replacements and regular expressions both have limits, so a bad pattern cannot hang.

### Module syntax

DSH PTC mode executes each `run_code` as an async function body, where static `import` and `export` declarations are invalid. PTC Plus adapts those forms before execution with AST analysis.

The model writes normally:

```ts
import { readFile } from 'node:fs/promises'
```

Imports resolve from your project, and named/default imports stay live and read-only. The model never has to know that a `run_code` is really a function body.

## One measured A/B

One identity-blind paired run used `opencode-go/deepseek-v4-flash`. Both arms used the same versioned fixture, task prompts, permissions, and two replicates per task, so 18 sessions per arm.

| Across all 9 tasks | PTC Plus | DSH PTC mode (PTC Plus disabled) | Observed change |
| --- | ---: | ---: | ---: |
| Model requests | 66 | 88 | 25.0% fewer |
| Tool calls | 50 | 79 | 36.7% fewer |
| Token traffic | 729,642 | 942,901 | 22.6% fewer |
| Identity-blind rubric score | 138 / 162 | 118 / 162 | +12.3 percentage points |

The module-syntax task separated the two arms most clearly. PTC Plus finished both replicates with one `run_code` each. DSH PTC mode without PTC Plus finished neither static-import requirement and used eight tool calls across its attempts.

This is one stochastic paired observation, not a performance guarantee. Machine budgets were exceeded in 2 of the 18 PTC Plus sessions and 5 of the 18 sessions without PTC Plus, so the matrix as a whole did not pass machine acceptance. Token traffic includes input, cache-read, cache-write, and output tokens. The fixture, pairing rules, metrics, and blind-review protocol are documented in [Evaluation](docs/evaluation.md).

![Rejected run_code and the follow-up edit_run_code repair](assets/ptc-plus-repair.png)

*A real session: the long code and the truthful `edit_run_code` repair call. The repair never resends the source.*

## Settings

Open **Settings → Plugin configuration** to use the card shown above. The `enabled` switch is live: turning it off leaves only the card and that switch, while turning it on restores the session runtime and `run_code`/`edit_run_code`.

Every setting applies immediately and keeps existing bindings. A failed change rolls back. Node fixes a worker's V8 old-generation limit when the worker starts, so that one setting is rejected while a session worker is active and can be changed after the session is disposed. A failed enable is rolled back and persisted as disabled.

`cordisToolsEnabled` is off by default. Turning it on immediately adds DSH's official Cordis tools to PTC agents under `tools.*`; it does not change the direct `run_code`/`edit_run_code` surface. Cordis runs model-written plugins against the live DSH runtime, so enabling it requires shell-level trust.

See [Client UI](docs/client-ui.md), [ADR 0019](docs/adr/0019-plugin-settings-and-kill-switch.md), and [ADR 0020](docs/adr/0020-optional-cordis-tools-in-ptc-mode.md).

## Scope

PTC Plus provides the session-bound persistent `run_code` layer. DSH and the operating system continue to own native-tool authority, policy, approval, cancellation, sandboxing and process governance.

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
