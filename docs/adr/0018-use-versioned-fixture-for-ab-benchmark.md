# Use A Versioned Fixture For The Ordinary-Task A/B Benchmark

## Problem

The ordinary-task A/B benchmark previously copied the active PTC Plus checkout into each arm. The workload therefore changed whenever the plugin repository grew, making absolute machine budgets and longitudinal comparisons unstable. The same source tree was also serving as the host, the treatment-under-test workspace, and the measurement workload, which mixes unrelated variables into one measurement.

## Decision

The primary ordinary-task A/B workload is now a purpose-built, versioned, zero-dependency Node.js fixture in `fixtures/ab-node-project-v1`. The fixture manifest is the single owner of the fixture name, version, content SHA-256, deterministic Git identity/commit, and deterministic dirty state. The runner materializes the fixture independently into each arm workspace, initializes the same deterministic Git history, applies the same uncommitted changes, and never copies the active PTC Plus checkout as the model workload.

The A/B task set contains a fixed, cheap, machine-checkable canary that exercises `run_code` before the full paired matrix starts. Reports record the fixture path, version, and content hash so future runs are grouped by benchmark version. The current PTC Plus checkout is kept as a separate self-hosting acceptance surface; it is not the stable README headline benchmark.

## Alternatives considered

**Keep freezing the active PTC Plus checkout.** This preserved a single running workload but made the measurement scale track repository growth and precluded stable cross-version comparisons.

**Use a fixed snapshot of the DSH source tree.** This would decouple from plugin growth but remains a large, host-domain-coupled workload and would not isolate the fixture from DSH evolution.

**Synchronize fixture facts across the runner and task descriptors.** This spreads the version and content ownership across files and creates a drift hazard; the manifest is the single explicit owner instead.

**Continue using a blind-only canary.** This would make preflight depend on semantic review and spend quota before machine transport facts are known; the cheap machine-checkable canary stops an invalid build before paid work expands.

## Consequences

The benchmark workload is stable under unrelated PTC Plus source changes and has its own result series tied to `fixtureVersion` and content hash. Existing README totals from the checkout-based series are explicitly non-comparable to the new fixture series. Maintaining a benchmark now requires updating the fixture manifest together with the fixture content, and a materially different task set or fixture change starts a new series rather than reusing old totals.
