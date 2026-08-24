# Evaluation

## Host prerequisites

The model-backed runners support native Windows paths and WSL repositories mounted as `/mnt/<drive>/...`. They invoke the Windows DSH installation through `pwsh.exe`; the Windows process environment must resolve `dsh --version` and a drive-qualified `DSH_HOME` or user-profile `.dsh` directory. Native Linux and macOS DSH execution are not supported by these runners.

Both entrypoints validate path conversion, PowerShell startup, the installed DSH command, and the Windows DSH home before creating artifacts, scratch directories, or installing the development plugin. A failure uses the `PTC-EVAL-PREREQ` diagnostic and leaves the evaluation workspace unchanged.

## Stable ordinary-task A/B fixture

`npm run test:ab` uses a versioned, zero-dependency Node.js fixture as the primary ordinary-task workload. The fixture lives in `fixtures/ab-node-project-v1` and is copied independently into each arm workspace. Both arms receive byte-identical working trees, the same deterministic Git history, and the same deterministic uncommitted dirty state prepared by the runner.

The fixture manifest, `fixtures/ab-node-project-v1/benchmark-manifest.json`, owns:

- `fixtureName` and `fixtureVersion`;
- a content SHA-256 over the fixture tree (excluding the manifest itself);
- the Git identity, commit message, and date used when materializing each arm;
- the deterministic dirty-state entries applied after the initial commit.

The current series is `ab-node-project-v1` / `1.0.0` with content SHA-256 `807580baf64e367bb2dc047c389edf471e13077d54d50ee4b3a143c38f0cebd1`. Reports written by the A/B runner record the fixture path, version, and hash.

Self-hosting acceptance against the active PTC Plus checkout is a separate track: `npm run test:expensive` covers plugin-specific model workflows and integration edges. Comparable ordinary-task reports are grouped only by the fixture version and content hash.

## Protocol

The paired run uses the latest installed DSH release, a configured model, PTC mode's code-only direct-tool projection, and `danger-full-access`. The A/B task set contains ordinary project tasks plus a cheap machine-checkable canary that directly invokes `run_code` once and exercises the transport first. After the canary pair passes, the remaining pairs run with the configured concurrency.

Resolved configurations are identical except for `ptc-plus.disabled`. Agent instructions, skills, auxiliary title generation, and local identity extensions are disabled. The model route, permission mode, neutral persona, injected initial context, fixture bytes, and resolved tool surface stay paired within each run.

The generated overlay explicitly owns and the preflight validates `tools.mode`, `sandbox-policy.mode`, and `approval.policy`. The runners do not rely on child-process environment variables to project these policies across the WSL-to-Windows execution boundary.

Each arm executes in an independently named, opaque scratch tree outside the evaluator artifact tree. Treatment names are confined to evaluator-owned records. Blind packets replace the session workspace in descriptions, source, results, and final answers, including Windows, forward-slash, and JSON-escaped spellings, before the arm map is written.

Machine budgets are per session and are enforced as failures. Machine evidence comes from exact tool-result JSON, workspace postconditions, or runner-owned subprocess results. Free-form final answers are never interpreted with prose or negation matching; their correctness remains `blind-pending` until the blind packet is reviewed. The transport canary separately requires the observed `run_code` result to equal the fixture package name, so workspace state alone cannot admit the paid matrix.

For `test-gate`, a successfully completed runner-owned subprocess is valid evidence whether the tested project exits zero or nonzero. The observed exit code is recorded, while blind semantic review decides whether the answer reports it correctly. Failure to start or complete the oracle remains a runner failure.

Acceptance metrics follow durable session-log semantics. `modelRequests` counts `step/start` events, each representing one logical model loop step. `headerEpochs` counts `request/header` events, while `headerChanges` counts the subset whose reason is `change`; initial and equal resume epochs remain distinct epochs without being changes. `historyReplacements` counts events whose `surfaceOp.op` is `replace`. Provider retries can issue multiple adapter attempts within one logical step, and the current durable log does not expose a complete physical-attempt count, so no report field infers one from headers, assistant messages, or usage.

Stable-header acceptance canonicalizes empty fields by DSH rules and compares the exact system value and ordered complete tool-schema JSON across every header epoch. Any unapproved change fails with the first differing field. `headerPolicy.allowedTransitions` names the exact epoch and route, configuration, or capability condition; `headerPolicy.historyReplacements` declares an exact replacement count and never permits header drift. Hashes remain diagnostic report data rather than the correctness test.

## Reporting

Both runners require an explicit model route and credential-variable name before any host probing or artifact creation. The referenced credential variable must also contain a value:

```sh
DSH_PTC_ACCEPTANCE_PROVIDER=<provider> \
DSH_PTC_ACCEPTANCE_MODEL=<model> \
DSH_PTC_ACCEPTANCE_API_KEY_ENV=PROVIDER_API_KEY \
PROVIDER_API_KEY=<credential> \
npm run test:expensive

DSH_PTC_AB_PROVIDER=<provider> \
DSH_PTC_AB_MODEL=<model> \
DSH_PTC_AB_API_KEY_ENV=PROVIDER_API_KEY \
PROVIDER_API_KEY=<credential> \
npm run test:ab
```

`npm run test:ab` writes `report.json`, `report.md`, per-session trajectory artifacts, and blind-review packets under `artifacts/ab-trajectories/`. Both commands invoke the configured model and consume quota.

Token traffic is the sum of input, cache-read, cache-write, and output tokens. Model behavior is stochastic, so comparable new results establish a reproducible observation rather than a universal performance claim.
