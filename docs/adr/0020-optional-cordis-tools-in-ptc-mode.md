# 0020 Optional Cordis Tools in PTC Mode

Date: 2026-08-24

## Status

Accepted

## Context

DSH's shipped 创造模式 composes `@deepseek-ai/dsh-tool-cordis` into a native agent preset. PTC users may also need that official inspect/define/run/stop/undefine capability without leaving PTC mode, but adding it unconditionally would enlarge a high-authority tool surface and add stable schema/prompt cost to every request. PTC Plus must not copy DSH's Cordis implementation or turn this choice into another preset system.

Tool registration must finish before prompt assembly; otherwise the first request lacks Cordis schemas and guidance. DSH's synchronous `agent/created` lifecycle and agent context provide the required publication point and owner.

## Decision

Add `cordisToolsEnabled: boolean`, default `false`, as a live PTC Plus setting. When enabled, PTC Plus mounts the official `@deepseek-ai/dsh-tool-cordis` plugin in each agent scope that exposes `run_code`; disabling it disposes those fibers immediately. Its child fiber owns the tool registrations and `tool:cordis` prompt section and is disposed with the agent or PTC runtime. If an agent is created before `run_code` becomes visible, the owner retains it as pending and retries on the DSH tools-change signal.

The complete Cordis surface must be visible before the first prompt assembly. Missing `dynamicCordisRunner` or `cordisInspect` services, pending registration, or a partial same-name surface is a configuration error. A complete pre-existing surface keeps its current owner.

Cordis tools remain native program bindings under `tools.*`. The PTC code-only direct-tool projection remains exactly `[run_code, edit_run_code]`; native agents and unrelated scopes do not inherit this option.

## Alternatives Considered

1. Add the Cordis row to the PTC preset. Rejected: PTC Plus is installed as a host plugin and does not own or fork DSH's shipped preset files; the operator asked for a plugin setting.
2. Register Cordis tools during `system-prompt/assemble`. Rejected: provider and schema collection has already happened, so the first request would omit the tools and destabilize the next request prefix.
3. Copy or wrap the seven tool definitions. Rejected: DSH owns their schemas, guidance, lifecycle, authority, and compatibility. Reimplementation would drift and create a second contract.
4. Enable the tools by default. Rejected: the tools can execute model-written plugins against the live runtime and carry a fixed schema cost. That trust and context expansion must be explicit.

## Consequences

PTC Plus gains a direct dependency on the maintained DSH Cordis tool plugin. When enabled, Cordis schemas and guidance become part of the stable prompt prefix for PTC agents; disabled configurations remain unchanged. Changing this option updates the live agent scopes without a DSH restart.
