/**
 * Session-bound REPL for DeepSeek Harness PTC mode.
 *
 * DSH's run_code bridge does not pass session identity to CodeRuntime.run().
 * The tools/execute around-hook carries that identity into the runtime bridge,
 * which redirects only those runs to a persistent per-session kernel.
 */

import Schema from '@deepseek-ai/schemastery'
import { createDirectSurfaceOwner } from './internal/direct-surface-owner.js'
import { createCordisToolsOwner } from './internal/cordis-tools-owner.js'
import { createEditTransportOwner, EDIT_RUN_CODE } from './internal/edit-transport-owner.js'
import { createRuntimeBridgeOwner, RUN_CODE } from './internal/runtime-bridge-owner.js'
import { resolveConfig } from './internal/runtime-config.js'
import {
  CONFIG_FIELDS,
  SETTINGS_NAMESPACE,
} from './internal/config-spec.js'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

const INSTALL_CLEANUP = Symbol('ptc-plus install cleanup')

/** Plugin name used by loader diagnostics. */
export const name = 'ptc-plus'

/** Runtime limits and behavior exposed to Cordis configuration. */
function configSchemaField(field) {
  const base = field.type === 'boolean'
    ? Schema.boolean().default(field.default)
    : Schema.number().step(1).min(field.min).max(field.max).default(field.default)
  return base.description(field.description)
}

export const Config = Schema.object(Object.fromEntries(
  CONFIG_FIELDS.map(field => [field.key, configSchemaField(field)]),
))

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

The host may append a bounded recovery context after a qualifying failure. Treat that context as a session-log-derived diagnostic: use \`edit_run_code\` only when it explicitly proves a complete-cell rerun is safe; otherwise inspect live state in a new short \`run_code\` cell.

## Cell conventions
Expressions that are neither returned nor printed produce no output. Keep large inspection results in bindings or reduce them to targeted excerpts: \`tools.read\` is bounded inspection, not a lossless whole-file reader. Cells are async function bodies; ${moduleSyntax} Use dynamic import or require explicitly when static module syntax is unsupported. ${redeclaration} ${splitSyntax}

## Available capabilities
Use \`capabilities.tree()\`, \`capabilities.find()\`, and \`capabilities.inspect()\` to discover the current request's live \`tools.*\` members before calling an unfamiliar binding. Prefer direct current-cell work; reserve \`code.run\` for source already held as data.

Native tool availability, executable names, shells, and path syntax depend on the current DSH profile and execution world; inspect them instead of assuming Windows, WSL, POSIX, or a particular shell. ${recovery}`
}

/** Register the session-bound REPL runtime. */
function installPtCRuntime(ctx, resolvedConfig, toolSchemasForAgent, sessionId) {
  let activeConfig = resolvedConfig
  let cordisTools
  let runtimeBridge
  let editTransport
  let directSurface
  const disposers = []
  let disposed = false
  async function dispose() {
    if (disposed) return
    disposed = true
    const failures = []
    for (const dispose of [...disposers].reverse()) {
      if (typeof dispose !== 'function') continue
      try {
        await dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    for (const owner of [directSurface, editTransport, runtimeBridge, cordisTools]) {
      try {
        await owner?.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'ptc-plus runtime disposal failed')
  }
  try {
    cordisTools = activeConfig.cordisToolsEnabled
      ? createCordisToolsOwner(ctx)
      : undefined
    runtimeBridge = createRuntimeBridgeOwner({
      ctx,
      sessionConfig: activeConfig,
      maxNestedRunCodeDepth: activeConfig.maxNestedRunCodeDepth,
      sessionId,
      toolSchemasForAgent,
    })
    editTransport = createEditTransportOwner(ctx, {
      durableReplay: activeConfig.durableReplay,
      executeTentative: runtimeBridge.executeTentative,
      sessionId,
      toolSchemasForAgent,
    })
    directSurface = createDirectSurfaceOwner({
      editTransport,
      runtimeConfig: activeConfig,
      canonicalizeToolCalls: activeConfig.canonicalizeToolCalls,
      sessionId,
      toolSchemasForAgent,
    })
    disposers.push(ctx.systemPrompt.section({
      name: 'tools:ptc-plus-repl',
      order: 98,
      text: context => {
        if (ctx.tools.get(RUN_CODE, context?.scope) === undefined) return ''
        return replGuidance(
          activeConfig.looseTopLevelRedeclarations,
          activeConfig.durableReplay,
          activeConfig.autoRewriteImports,
          activeConfig.autoStripExports,
          activeConfig.autoSplitRedeclarations,
        )
      },
    }))
    disposers.push(ctx.on('system-prompt/assemble', (assembly, context, next) => (
      directSurface.assemble(assembly, context, next)
    )))
    disposers.push(ctx.on('llm/stream', (options, next) => directSurface.stream(options, next), { global: true }))
    disposers.push(ctx.on('tools/execute', (exec, next) => {
      const rejected = directSurface.executionRejection(exec)
      if (rejected !== undefined) return rejected
      if (exec.name === RUN_CODE) return runtimeBridge.handleExecute(exec, next)
      return next()
    }))
    disposers.push(ctx.on('tools/result', (exec, result) => {
      directSurface.handleResult(exec)
      if (exec.name === EDIT_RUN_CODE) return editTransport.handleResult(exec, result)
      if (exec.name === RUN_CODE) return runtimeBridge.handleResult(exec, result)
    }))
    disposers.push(ctx.on('agent/disposed', ({ agent }) => {
      directSurface.disposeAgent(agent)
      editTransport.disposeAgent(agent)
      return runtimeBridge.disposeAgent(agent)
    }))
    disposers.push(ctx.on('session/disposed', (session) => {
      directSurface.disposeSession(session)
      editTransport.disposeSession(session)
      return runtimeBridge.disposeSession(session)
    }))
  } catch (error) {
    const cleanup = dispose()
    if (error !== null && typeof error === 'object') {
      Object.defineProperty(error, INSTALL_CLEANUP, { value: cleanup })
    }
    throw error
  }
  async function reconfigure(nextConfig) {
    if (disposed) return
    const previousConfig = activeConfig
    const rollbacks = []
    try {
      runtimeBridge.reconfigure(nextConfig)
      rollbacks.push(() => runtimeBridge.reconfigure(previousConfig))
      editTransport.reconfigure(nextConfig)
      rollbacks.push(() => editTransport.reconfigure(previousConfig))
      directSurface.reconfigure(nextConfig)
      rollbacks.push(() => directSurface.reconfigure(previousConfig))

      if (nextConfig.cordisToolsEnabled && cordisTools === undefined) {
        cordisTools = createCordisToolsOwner(ctx)
      } else if (!nextConfig.cordisToolsEnabled && cordisTools !== undefined) {
        const currentCordis = cordisTools
        cordisTools = undefined
        try {
          await currentCordis.dispose()
        } catch (error) {
          try {
            cordisTools = createCordisToolsOwner(ctx)
          /* c8 ignore next */
          } catch (rollbackError) { throw new AggregateError([error, rollbackError], 'ptc-plus: Cordis reconfiguration and rollback failed', { cause: error }) }
          throw error
        }
      }
      activeConfig = nextConfig
    } catch (error) {
      const rollbackFailures = []
      /* c8 ignore next -- the rollback loop's rejection branch is host-specific. */
      for (const rollback of rollbacks.reverse()) {
        try {
          await rollback()
        /* c8 ignore next */
        } catch (rollbackError) { rollbackFailures.push(rollbackError) }
      }
      /* c8 ignore next */
      if (rollbackFailures.length > 0) { throw new AggregateError([error, ...rollbackFailures], 'ptc-plus: live runtime reconfiguration rollback failed', { cause: error }) }
      throw error
    }
  }

  return Object.freeze({ dispose, reconfigure })
}

/** Register the session-bound REPL runtime. */
export function apply(ctx, config = {}) {
  const resolvedConfig = resolveConfig(config)
  const toolSchemasForAgent = agent => typeof ctx.tools.schemas === 'function'
    ? ctx.tools.schemas(agent)
    : []
  const sessionId = agent => {
    const id = agent?.session?.id ?? agent?.id
    return id === undefined ? undefined : String(id)
  }
  let runtime
  let installed = false
  let disposed = false
  let lifecycleTail = Promise.resolve()
  let pendingOperations = 0
  const trackLifecycle = operation => {
    pendingOperations += 1
    const tracked = Promise.resolve(operation)
    lifecycleTail = Promise.allSettled([tracked])
    const settle = () => { pendingOperations -= 1 }
    tracked.then(settle, settle)
    return tracked
  }
  const enqueueLifecycle = task => {
    const operation = lifecycleTail.then(task, task)
    return trackLifecycle(operation)
  }
  const controller = {
    install(nextConfig) {
      if (installed || disposed) return lifecycleTail
      const install = () => {
        if (installed || disposed) return
        try {
          if (ctx.codeRuntime.language !== 'typescript') {
            throw new Error('ptc-plus: unsupported code runtime language ' + JSON.stringify(ctx.codeRuntime.language) + '; only "typescript" is supported')
          }
          runtime = installPtCRuntime(ctx, nextConfig, toolSchemasForAgent, sessionId)
        } catch (error) {
          const cleanup = error?.[INSTALL_CLEANUP]
          if (cleanup !== undefined) trackLifecycle(cleanup)
          throw error
        }
        installed = true
      }
      if (pendingOperations > 0) return enqueueLifecycle(install)
      install()
      return lifecycleTail
    },
    uninstall() {
      if (!installed && pendingOperations === 0) return lifecycleTail
      if (installed) {
        const current = runtime
        runtime = undefined
        installed = false
        return enqueueLifecycle(() => current.dispose())
      }
      return enqueueLifecycle(async () => {
        if (!installed) return
        const current = runtime
        runtime = undefined
        installed = false
        await current.dispose()
      })
    },
    reconfigure(nextConfig) {
      if (!installed || disposed) return lifecycleTail
      const current = runtime
      return enqueueLifecycle(() => current?.reconfigure(nextConfig))
    },
    async dispose() {
      disposed = true
      await controller.uninstall()
    },
  }
  ctx.effect(() => async () => controller.dispose(), 'ptc-plus runtime lifecycle')

  let configSource = () => resolvedConfig
  let activeConfig = resolvedConfig
  let configurationGeneration = 0
  let settingsWriter
  let activationRollback = false
  let configurationRollback = false
  const reportActivationFailure = (error) => {
    ctx.logger?.warn?.('ptc-plus: runtime activation failed', error)
  }
  const handleActivationFailure = async (error) => {
    if (activationRollback) return
    activationRollback = true
    try {
      // Failed installation cleanup is tracked and all-settled by the lifecycle queue.
      await controller.uninstall()
      reportActivationFailure(error)
      if (settingsWriter?.update === undefined) return
      try {
        await settingsWriter.update(settingsNamespace(SETTINGS_NAMESPACE), { enabled: false })
      } catch (rollbackError) {
        reportActivationFailure(new Error(
          `ptc-plus: failed to roll back enabled setting: ${rollbackError.message}`,
          { cause: error },
        ))
      }
    } finally {
      activationRollback = false
    }
  }
  const handleConfigurationFailure = async (error, previousConfig, generation) => {
    reportActivationFailure(new Error(
      `ptc-plus: live configuration failed: ${error.message}`,
      { cause: error },
    ))
    // A newer settings update may already be queued behind this operation.
    // Its desired state must win; an older failure must not restore stale data.
    if (generation !== configurationGeneration || configurationRollback) return
    configurationRollback = true
    try {
      if (settingsWriter?.update === undefined) return
      const patch = Object.fromEntries(CONFIG_FIELDS.map(field => [field.key, previousConfig[field.key]]))
      try {
        await settingsWriter.update(settingsNamespace(SETTINGS_NAMESPACE), patch)
      } catch (rollbackError) {
        reportActivationFailure(new Error(
          `ptc-plus: failed to roll back live configuration: ${rollbackError.message}`,
          { cause: error },
        ))
      }
    } finally {
      configurationRollback = false
    }
  }
  const reconcile = () => {
    const current = resolveConfig(configSource())
    const generation = ++configurationGeneration
    if (!current.enabled) {
      void controller.uninstall().catch(error => reportActivationFailure(new Error(
        `ptc-plus: runtime disable failed: ${error.message}`,
        { cause: error },
      )))
      return
    }
    if (activationRollback || configurationRollback) return
    try {
      const operation = installed
        ? controller.reconfigure(current)
        : controller.install(current)
      void Promise.resolve(operation).then(() => {
        activeConfig = current
      }).catch(error => {
        if (installed) return handleConfigurationFailure(error, activeConfig, generation)
        return handleActivationFailure(error)
      })
    } catch (error) {
      if (settingsWriter === undefined) throw error
      if (installed) void handleConfigurationFailure(error, activeConfig, generation)
      else void handleActivationFailure(error)
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], settings => {
      settingsWriter = settings.settings
    })
    installSettingsSection(
      ctx,
      settingsNamespace(SETTINGS_NAMESPACE),
      Config,
      resolvedConfig,
      {
        setSource(source) {
          configSource = source
        },
        onChange: reconcile,
      },
    )
  }
  reconcile()
}
