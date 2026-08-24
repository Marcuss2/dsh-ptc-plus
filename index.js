/**
 * Session-bound REPL for DeepSeek Harness PTC mode.
 *
 * DSH's run_code bridge does not pass session identity to CodeRuntime.run().
 * The tools/execute around-hook carries that identity into the runtime bridge,
 * which redirects only those runs to a persistent per-session kernel.
 */

import Schema from '@deepseek-ai/schemastery'
import { createDirectSurfaceOwner } from './internal/direct-surface-owner.js'
import { createEditTransportOwner, EDIT_RUN_CODE } from './internal/edit-transport-owner.js'
import { createRuntimeBridgeOwner, RUN_CODE } from './internal/runtime-bridge-owner.js'
import { MAX_TIMER_DELAY_MS } from './internal/runtime-config.js'

const DEFAULT_MAX_NESTED_RUN_CODE_DEPTH = 8

/** Plugin name used by loader diagnostics. */
export const name = 'ptc-plus'

/** Runtime limits and behavior exposed to Cordis configuration. */
export const Config = Schema.object({
  computeMs: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(60_000)
    .description('Maximum synchronous CPU time for one cell, in milliseconds.'),
  maxWallMs: Schema.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(600_000)
    .description('Maximum elapsed time for one cell, in milliseconds.'),
  maxOutputBytes: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(64 * 1024 * 1024)
    .description('Maximum encoded result and rendered output size in bytes.'),
  maxOldGenerationSizeMb: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(512)
    .description('V8 old-generation memory limit for each session worker, in MiB.'),
  maxValueNodes: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(100_000)
    .description('Maximum nodes in one PTC value graph.'),
  maxValueEdges: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1_000_000)
    .description('Maximum edges in one PTC value graph.'),
  maxValueArrayLength: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1_000_000)
    .description('Maximum declared length of one encoded array.'),
  maxValueBigIntDigits: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(100_000)
    .description('Maximum decimal digits in one encoded BigInt.'),
  maxNestedRunCodeDepth: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_MAX_NESTED_RUN_CODE_DEPTH)
    .description('Maximum recursive code.run depth.'),
  canonicalizeToolCalls: Schema.boolean().default(true)
    .description('Lower live-schema-proven top-level native tool calls into PTC mode run_code cells.'),
  looseTopLevelRedeclarations: Schema.boolean().default(true)
    .description('Allow complete top-level const and let declarators to replace existing bindings.'),
  durableReplay: Schema.boolean().default(true)
    .description('Reconstruct durable cells from the session log after a worker restart.'),
  autoRewriteImports: Schema.boolean().default(true)
    .description('Adapt static import declarations through worker-preloaded module namespaces.'),
  autoStripExports: Schema.boolean().default(true)
    .description('Strip top-level export modifiers before cell parsing.'),
  autoSplitRedeclarations: Schema.boolean().default(true)
    .description('Allow mixed existing and fresh names in one top-level destructuring declaration.'),
  tipsEnabled: Schema.boolean().default(true)
    .description('Add bounded, session-log-derived recovery tips to runtime context.'),
  tipCooldownMessages: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(3)
    .description('Minimum model-context steps between two recovery tips.'),
  tipEscalationFailures: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2)
    .description('Repeated unresolved triggers before a recovery tip becomes detailed.'),
})

/** Services required by the plugin. */
export const inject = ['tools', 'codeRuntime', 'systemPrompt', 'agents', 'llm']

function replGuidance(
  looseTopLevelRedeclarations,
  durableReplay,
  autoRewriteImports,
  autoStripExports,
  autoSplitRedeclarations,
) {
  const redeclaration = looseTopLevelRedeclarations
    ? 'Repeated top-level `const`/`let` declarations replace existing bindings.'
    : 'Redeclaring an existing top-level name fails before execution, so reuse it or place one-off declarations inside a block.'
  const moduleSyntax = autoRewriteImports && autoStripExports
    ? 'static `import` declarations are adapted with live, read-only bindings and top-level `export` modifiers are stripped automatically.'
    : autoRewriteImports
      ? 'static `import` declarations are adapted with live, read-only bindings; top-level `export` modifiers remain unsupported.'
      : autoStripExports
        ? 'top-level `export` modifiers are stripped automatically; static `import` declarations remain unsupported.'
        : 'static `import` declarations and top-level `export` modifiers remain unsupported.'
  const splitSyntax = autoSplitRedeclarations
    ? 'Mixed new/existing top-level destructuring is split automatically while preserving assignment semantics.'
    : 'Mixed new/existing top-level destructuring remains unsupported; separate the declaration from the assignment.'
  const recovery = durableReplay
    ? 'Direct Node/OS access remains live but is not replayed after a kernel restart.'
    : 'Durable replay is disabled for this profile. Bindings remain reusable only in the current process; a new kernel starts empty.'
  return `\`run_code\` continues one persistent PTC REPL. Ordinary top-level bindings remain available to later cells, so reuse them instead of resending setup code. Choose the smallest cell that answers the request and return only the value the next step needs.

## Failure recovery
After a failure, start with a new short \`run_code\` cell. \`state: partially-applied\` means statements before the failure may have run and their bindings may still be live: inspect or reuse them before repeating work. If the cell may have run a command, written a file, sent a request, changed external state, or called an unfamiliar tool, never edit or replay it just to repair a later expression. For example, after a tool call succeeds but displaying its result fails, use the existing result binding in a new cell.

Use \`edit_run_code\` only when a small correction can safely rerun the complete cell. It does not resume at the failing line. \`state: unchanged\` means no new binding was created; retry only after checking whether an external action could still have happened. The \`tools\`, \`capabilities\`, \`repl\`, and \`code\` handles are cell-scoped; \`repl.state\` is for explicit named checkpoints, not ordinary continuation.

## Cell conventions
Expressions that are neither returned nor printed produce no output. Keep large inspection results in bindings or reduce them to targeted excerpts: \`tools.read\` is bounded inspection, not a lossless whole-file reader. Cells are async function bodies; ${moduleSyntax} Use dynamic import or require explicitly when static module syntax is unsupported. ${redeclaration} ${splitSyntax}

## Available capabilities
Use \`capabilities.tree()\`, \`capabilities.find()\`, and \`capabilities.inspect()\` to discover the current request's live \`tools.*\` members before calling an unfamiliar binding. Prefer direct current-cell work; reserve \`code.run\` for source already held as data.

Native tool availability, executable names, shells, and path syntax depend on the current DSH profile and execution world; inspect them instead of assuming Windows, WSL, POSIX, or a particular shell. ${recovery}`
}

function sessionId(agent) {
  const id = agent?.session?.id ?? agent?.id
  return id === undefined ? undefined : String(id)
}

/** Register the session-bound REPL runtime. */
export function apply(ctx, config = {}) {
  if (ctx.codeRuntime.language !== 'typescript') {
    throw new Error(`ptc-plus: unsupported code runtime language ${JSON.stringify(ctx.codeRuntime.language)}; only "typescript" is supported`)
  }
  const maxNestedRunCodeDepth = config.maxNestedRunCodeDepth ?? DEFAULT_MAX_NESTED_RUN_CODE_DEPTH
  if (!Number.isSafeInteger(maxNestedRunCodeDepth) || maxNestedRunCodeDepth < 1) {
    throw new TypeError('ptc-plus: maxNestedRunCodeDepth must be a positive safe integer')
  }
  const {
    maxNestedRunCodeDepth: _nestedDepth,
    canonicalizeToolCalls: _canonicalizeToolCalls,
    ...sessionConfig
  } = config
  const canonicalizeToolCalls = config.canonicalizeToolCalls ?? true
  if (typeof canonicalizeToolCalls !== 'boolean') {
    throw new TypeError('ptc-plus: canonicalizeToolCalls must be a boolean')
  }
  const toolSchemasForAgent = agent => typeof ctx.tools.schemas === 'function'
    ? ctx.tools.schemas(agent)
    : []

  const runtimeBridge = createRuntimeBridgeOwner({
    ctx,
    sessionConfig,
    maxNestedRunCodeDepth,
    sessionId,
    toolSchemasForAgent,
  })
  const editTransport = createEditTransportOwner(ctx, {
    durableReplay: runtimeBridge.config.durableReplay,
    executeTentative: runtimeBridge.executeTentative,
    sessionId,
    toolSchemasForAgent,
  })
  const directSurface = createDirectSurfaceOwner({
    editTransport,
    runtimeConfig: runtimeBridge.config,
    canonicalizeToolCalls,
    sessionId,
    toolSchemasForAgent,
  })

  ctx.systemPrompt.section({
    name: 'tools:ptc-plus-repl',
    order: 98,
    text: context => {
      if (ctx.tools.get(RUN_CODE, context.scope) === undefined) return ''
      return replGuidance(
        config.looseTopLevelRedeclarations ?? true,
        runtimeBridge.config.durableReplay,
        runtimeBridge.config.autoRewriteImports,
        runtimeBridge.config.autoStripExports,
        runtimeBridge.config.autoSplitRedeclarations,
      )
    },
  })
  ctx.on('system-prompt/assemble', (assembly, context, next) => (
    directSurface.assemble(assembly, context, next)
  ))
  ctx.on('llm/stream', (options, next) => directSurface.stream(options, next), { global: true })
  ctx.on('tools/execute', (exec, next) => {
    const rejected = directSurface.executionRejection(exec)
    if (rejected !== undefined) return rejected
    if (exec.name === RUN_CODE) return runtimeBridge.handleExecute(exec, next)
    return next()
  })
  ctx.on('tools/result', (exec, result) => {
    directSurface.handleResult(exec)
    if (exec.name === EDIT_RUN_CODE) return editTransport.handleResult(exec, result)
    if (exec.name === RUN_CODE) return runtimeBridge.handleResult(exec, result)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    directSurface.disposeAgent(agent)
    editTransport.disposeAgent(agent)
    return runtimeBridge.disposeAgent(agent)
  })
  ctx.on('session/disposed', (session) => {
    directSurface.disposeSession(session)
    editTransport.disposeSession(session)
    return runtimeBridge.disposeSession(session)
  })
  ctx.effect(() => async () => {
    directSurface.dispose()
    editTransport.dispose()
    await runtimeBridge.dispose()
  }, 'ptc-plus session runtime teardown')
}
