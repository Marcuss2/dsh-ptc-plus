# 0020 Optional Cordis Tools in PTC Mode

Date: 2026-08-24

## Status

Accepted

## Context

DSH's shipped 创造模式 composes `@deepseek-ai/dsh-tool-cordis` and the `cordis-plugin-development` companion Skill into its native `cordis` preset. PTC users may also need that complete official authoring workflow without leaving PTC mode, but adding it unconditionally would enlarge a high-authority tool surface and add stable schema/prompt cost to every request. PTC Plus must not copy DSH's Cordis implementation or Skill content, or turn this choice into another preset system.

Tool registration must finish before the prompt assembly returned to the agent; otherwise the first request lacks Cordis schemas and guidance. DSH's synchronous `agent/created` lifecycle and agent context provide the publication point and owner, but child-fiber readiness can still overlap the first provider snapshot.

## Decision

Add `cordisToolsEnabled: boolean`, default `false`, as a live PTC Plus setting. When enabled, PTC Plus mounts the official `@deepseek-ai/dsh-tool-cordis` plugin and a maintained `@deepseek-ai/dsh-skill-filesystem` provider in each agent scope that exposes `run_code`; disabling it disposes both fibers immediately. The provider resolves the shipped `cordis` preset through the public `agentPresets` service and publishes only its sibling `skills` directory under a PTC Plus-specific provider name. It neither switches the current preset nor includes default roots. If an agent is created before `run_code` becomes visible, the owner retains it as pending and retries on the DSH tools-change signal.

The Skill provider and official Cordis child fiber form one reversible mount. Both must settle, and the scoped `skills` service must prove that `cordis-plugin-development` resolves from the added provider as model-invocable and loadable, before the first prompt assembly is returned. A prepended public `system-prompt/assemble` waterfall listener is the final race barrier: if collection began before the mount settled, it waits for readiness, discards that stale assembly, and invokes public assembly again so DSH recollects the official providers. It does not synthesize or mutate Cordis schemas or guidance. The Cordis fiber's resolved `inject` declaration is the authoritative required-service list, and its live registrations are the authoritative tool names, schemas, and guidance. A missing or broken preset, Skill service/tool, declared service, publication, or child fiber is a configuration error and rolls back every contribution.

The official plugin also registers Host inspect providers in the process-global `cordisInspect` service. Per-agent fibers therefore acquire owner-scoped leases for identical provider manifests instead of registering the same provider ID independently. Queries delegate to a registration from a still-live official fiber, and the process-global provider is removed when the final lease is released. A manifest mismatch remains a configuration error rather than silently choosing one contract.

Cordis tools remain native program bindings under `tools.*`. The PTC code-only direct-tool projection remains exactly `[run_code, edit_run_code]`; native agents and unrelated scopes do not inherit this option.

## Alternatives Considered

1. Add the Cordis row to the PTC preset. Rejected: PTC Plus is installed as a host plugin and does not own or fork DSH's shipped preset files; the operator asked for a plugin setting.
2. Register Cordis tools during `system-prompt/assemble` and continue with the existing assembly. Rejected: provider and schema collection has already happened, so waiting alone would still omit the tools. The selected barrier instead discards that stale snapshot and asks DSH's public assembler to recollect after the owner-controlled mount is ready.
3. Copy the tool definitions or their current names. Rejected: DSH owns their schemas, guidance, lifecycle, authority, and compatibility. Even a names-only completeness list would drift when DSH evolves and create a second contract.
4. Enable the tools by default. Rejected: the tools can execute model-written plugins against the live runtime and carry a fixed schema cost. That trust and context expansion must be explicit.
5. Mount one global Cordis tool fiber and hide it from native agents. Rejected: its prompt hook and `@pluginId` context listener would remain global even if tool schemas were restricted, so unrelated agents would inherit behavior they did not enable.
6. Copy `SKILL.md` into PTC Plus or add the Cordis preset's directory to global Skill roots. Rejected: copied instructions drift, while a global root leaks the optional workflow into agents that did not enable it.

## Consequences

PTC Plus declares the maintained DSH Cordis tool, Skill filesystem, settings, and tool-runtime packages as required peers through the current release channel and mirrors them in development dependencies. They resolve from DSH's installation-maintained profile fallback; installing PTC Plus must not add a profile-local DSH core package instance. When enabled, the official Cordis schemas, guidance, and companion Skill become available together in PTC agent scopes; disabled configurations remain unchanged. Changing this option updates live agent scopes without a DSH restart, including repeated disable/re-enable cycles. A DSH release may rename or reshape its Cordis surface without requiring a mirrored-name change in PTC Plus, provided the public plugin, preset, Skill, and inspect-provider contracts remain compatible.
