import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, Config } from '../index.js'
import { CORDIS_TOOL_NAMES } from '../internal/cordis-tools-owner.js'
import { SETTINGS_NAMESPACE } from '../internal/config-spec.js'
import { resolveConfig } from '../internal/runtime-config.js'

function settingsScope(value) {
  let current = value
  const watchers = []
  const commit = next => {
    const previous = current
    current = next
    for (const callback of watchers) callback(current, previous)
  }
  return {
    get: () => current,
    watch: callback => {
      watchers.push(callback)
      return () => {}
    },
    set(next) {
      commit(next)
    },
    async update(patch) {
      commit({ ...current, ...patch })
    },
    watchers,
  }
}

function settingsContext(scope) {
  return {
    settings: {
      register: () => scope,
      update: (_namespace, patch) => scope.update(patch),
    },
    effect(register) {
      register()
    },
  }
}

function hostContext(settings = undefined, agents = [], options = {}) {
  const listeners = new Map()
  const cleanups = []
  const sections = []
  const inheritedRun = async () => ({ logs: [] })
  const runtime = Object.assign(Object.create({ run: inheritedRun }), {
    language: options.language ?? 'typescript',
    isolation: 'worker-thread',
  })
  const definition = { name: 'run_code', output: {} }
  const ctx = {
    fiber: { state: 2 },
    agents: { list: () => agents },
    codeRuntime: runtime,
    tools: {
      get: () => definition,
      schemas: () => [],
      register: () => () => {},
    },
      systemPrompt: {
        section: value => {
        if (options.failPromptSection === true) throw new Error('prompt section unavailable')
        sections.push(value)
        return () => {
          if (options.throwSectionDispose === true) throw new Error('prompt section disposal failed')
          sections.splice(sections.indexOf(value), 1)
        }
      },
    },
    on(name, listener) {
      if (options.failHook === name) throw new Error(`hook unavailable: ${name}`)
      const entries = listeners.get(name) ?? []
      entries.push(listener)
      listeners.set(name, entries)
      return () => {
        entries.splice(entries.indexOf(listener), 1)
        if (entries.length === 0) listeners.delete(name)
      }
    },
    effect(register) {
      cleanups.push(register())
    },
    logger: {
      warnings: [],
      warn(message, error) { this.warnings.push([message, error]) },
    },
    ...(settings === undefined ? {} : {
      inject(services, callback) {
        assert.deepEqual(services, ['settings'])
        settings.fiber ??= { state: 2 }
        callback(settings)
      },
    }),
  }
  return { ctx, listeners, sections, cleanups, runtime, definition }
}

function cordisAgent(disposeGate = undefined, options = {}) {
  const definitions = new Map([['run_code', { name: 'run_code' }]])
  let pluginCalls = 0
  let disposeFailuresRemaining = options.disposeFailures ?? 0
  const agent = {
    id: 'settings-cordis-agent',
    ctx: {
      tools: {
        get: name => definitions.get(name),
      },
      get: name => name === 'dynamicCordisRunner' || name === 'cordisInspect' ? {} : undefined,
      plugin(plugin) {
        pluginCalls += 1
        assert.equal(plugin.name, 'tool-cordis')
        for (const name of CORDIS_TOOL_NAMES) definitions.set(name, { name })
        return {
          async dispose() {
            if (disposeGate !== undefined) await disposeGate
            for (const name of CORDIS_TOOL_NAMES) definitions.delete(name)
            if (options.throwDispose === true || disposeFailuresRemaining > 0) {
              if (disposeFailuresRemaining > 0) disposeFailuresRemaining -= 1
              throw new Error('Cordis disposal failed')
            }
          },
        }
      },
    },
  }
  return {
    agent,
    definitions,
    get pluginCalls() {
      return pluginCalls
    },
  }
}

async function openSessionWorker(host, agent) {
  const exec = { name: 'run_code', callId: 'settings-worker', agent }
  const result = await host.listeners.get('tools/execute')[0](exec, async () => {
    const raw = await host.runtime.run({ program: 'return 1', bindings: [] })
    return {
      isError: raw.error !== undefined,
      content: [],
      ...(raw.error === undefined ? { value: raw.value } : { error: raw.error }),
      meta: host.definition.output.presentationMeta?.({}, raw.value),
    }
  })
  for (const listener of host.listeners.get('tools/result') ?? []) await listener(exec, result)
  assert.equal(result.isError, false)
}

test('settings kill switch leaves no runtime side effects when disabled', async () => {
  const scope = settingsScope({ enabled: false })
  const { ctx, listeners, sections, cleanups, runtime } = hostContext(settingsContext(scope))
  apply(ctx)
  assert.equal(Object.hasOwn(runtime, 'run'), false)
  assert.equal(listeners.size, 0)
  assert.equal(sections.length, 0)
  for (const cleanup of cleanups.reverse()) await cleanup()
})

test('disabled settings can load on hosts without a TypeScript runtime', async () => {
  const scope = settingsScope({ enabled: false })
  const { ctx, listeners, sections, cleanups, runtime } = hostContext(
    settingsContext(scope),
    [],
    { language: 'python' },
  )

  assert.doesNotThrow(() => apply(ctx))
  assert.equal(Object.hasOwn(runtime, 'run'), false)
  assert.equal(listeners.size, 0)
  assert.equal(sections.length, 0)

  scope.set({ ...scope.get(), enabled: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().enabled, false)
  assert.equal(Object.hasOwn(runtime, 'run'), false)
  assert.equal(ctx.logger.warnings.length > 0, true)

  for (const cleanup of cleanups.reverse()) await cleanup()
})

test('settings kill switch installs and removes the runtime live', async () => {
  const scope = settingsScope({
    enabled: true,
    durableReplay: false,
    autoRewriteImports: true,
    autoStripExports: true,
    autoSplitRedeclarations: true,
    looseTopLevelRedeclarations: true,
    canonicalizeToolCalls: true,
    tipsEnabled: true,
    tipCooldownMessages: 3,
    tipEscalationFailures: 2,
  })
  const { ctx, listeners, sections, cleanups, runtime } = hostContext(settingsContext(scope))
  apply(ctx)
  assert.equal(Object.hasOwn(runtime, 'run'), true)
  assert.ok(listeners.has('tools/execute'))
  assert.ok(sections.some(section => section.name === 'tools:ptc-plus-repl'))

  scope.set({ ...scope.get(), enabled: false })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(Object.hasOwn(runtime, 'run'), false)
  assert.equal(listeners.size, 0)
  assert.equal(sections.length, 0)

  scope.set({ ...scope.get(), enabled: true })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(Object.hasOwn(runtime, 'run'), true)
  assert.ok(listeners.has('tools/execute'))

  for (const cleanup of cleanups.reverse()) await cleanup()
  assert.equal(Object.hasOwn(runtime, 'run'), false)
})

test('late settings mount reconciles and detaches against composition config', async () => {
  const { ctx, listeners, sections, cleanups, runtime } = hostContext()
  let injectSettings
  ctx.inject = (services, callback) => {
    assert.deepEqual(services, ['settings'])
    injectSettings = callback
  }
  apply(ctx)
  assert.equal(Object.hasOwn(runtime, 'run'), true)

  const scope = settingsScope({ enabled: false })
  let detach
  const settings = settingsContext(scope)
  settings.fiber = { state: 2 }
  settings.effect = (register) => { detach = register() }
  injectSettings(settings)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(Object.hasOwn(runtime, 'run'), false)
  assert.equal(listeners.size, 0)
  assert.equal(sections.length, 0)

  detach()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(Object.hasOwn(runtime, 'run'), true)
  for (const cleanup of cleanups.reverse()) await cleanup()
})

test('late settings hydration applies persisted non-enabled configuration', async () => {
  const { agent, definitions } = cordisAgent()
  const { ctx, cleanups } = hostContext(undefined, [agent])
  let injectSettings
  ctx.inject = (_services, callback) => { injectSettings = callback }
  apply(ctx)
  assert.equal(CORDIS_TOOL_NAMES.some(name => definitions.has(name)), false)

  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const settings = settingsContext(scope)
  settings.fiber = { state: 2 }
  settings.effect = register => register()
  injectSettings(settings)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(CORDIS_TOOL_NAMES.some(name => definitions.has(name)), true)
  for (const cleanup of cleanups.reverse()) await cleanup()
})

test('startup settings mount Cordis tools before the first PTC request', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const { agent, definitions } = cordisAgent()
  const { ctx, cleanups } = hostContext(settingsContext(scope), [agent])
  apply(ctx)
  assert.deepEqual(
    CORDIS_TOOL_NAMES.filter(name => definitions.has(name)),
    CORDIS_TOOL_NAMES,
  )
  for (const cleanup of cleanups.reverse()) await cleanup()
  assert.equal(CORDIS_TOOL_NAMES.some(name => definitions.has(name)), false)
})

test('failed activation rolls back every mount created before the failing hook', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent()
  const { ctx, cleanups } = hostContext(settingsContext(scope), [cordis.agent], {
    failPromptSection: true,
  })
  apply(ctx)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().enabled, false)
  assert.equal(cordis.pluginCalls, 1)
  assert.equal(CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
  assert.equal(Object.hasOwn(ctx.codeRuntime, 'run'), false)
  assert.equal(ctx.logger.warnings.length > 0, true)

  for (const cleanup of cleanups.reverse()) await cleanup()
})

test('live enable failure is persisted as disabled and can recover after the host is restored', async () => {
  const scope = settingsScope({ enabled: false, cordisToolsEnabled: false })
  const host = hostContext(settingsContext(scope), [], { failPromptSection: true })
  apply(host.ctx)

  scope.set({ ...scope.get(), enabled: true })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().enabled, false)
  assert.equal(Object.hasOwn(host.runtime, 'run'), false)
  assert.equal(host.ctx.logger.warnings.length > 0, true)

  host.ctx.systemPrompt.section = value => {
    host.sections.push(value)
    return () => host.sections.splice(host.sections.indexOf(value), 1)
  }
  scope.set({ ...scope.get(), enabled: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().enabled, true)
  assert.equal(Object.hasOwn(host.runtime, 'run'), true)

  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('surfaces a settings rollback failure after activation cleanup', async () => {
  const scope = settingsScope({ enabled: false, cordisToolsEnabled: false })
  scope.update = async () => { throw new Error('settings offline') }
  const host = hostContext(settingsContext(scope), [], { failPromptSection: true, throwSectionDispose: true })
  apply(host.ctx)
  scope.set({ ...scope.get(), enabled: true })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().enabled, true)
  assert.equal(host.ctx.logger.warnings.length >= 2, true)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('continues rollback after one owner disposer rejects', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, { throwDispose: true })
  const host = hostContext(settingsContext(scope), [cordis.agent], {
    failHook: 'system-prompt/assemble',
    throwSectionDispose: true,
  })
  apply(host.ctx)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().enabled, false)
  assert.equal(CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('contains rejecting owner disposal during a live disable', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, { throwDispose: true })
  const host = hostContext(settingsContext(scope), [cordis.agent])
  const unhandled = []
  const onUnhandled = error => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  try {
    apply(host.ctx)
    scope.set({ enabled: false, cordisToolsEnabled: true })
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(Object.hasOwn(host.runtime, 'run'), false)
    assert.equal(unhandled.length, 0)
    assert.equal(host.ctx.logger.warnings.length > 0, true)
  } finally {
    process.off('unhandledRejection', onUnhandled)
    for (const cleanup of host.cleanups.reverse()) await cleanup()
  }
})

test('Cordis setting applies immediately across live kill-switch toggles', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: false })
  const { agent, definitions } = cordisAgent()
  const { ctx, cleanups } = hostContext(settingsContext(scope), [agent])
  apply(ctx)

  scope.set({ enabled: true, cordisToolsEnabled: true })
  scope.set({ enabled: false, cordisToolsEnabled: true })
  await new Promise(resolve => setTimeout(resolve, 0))
  scope.set({ enabled: true, cordisToolsEnabled: true })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(CORDIS_TOOL_NAMES.some(name => definitions.has(name)), true)

  for (const cleanup of cleanups.reverse()) await cleanup()
})

test('reconfigures Cordis immediately while the runtime stays enabled', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const { agent, definitions } = cordisAgent()
  const { ctx, cleanups } = hostContext(settingsContext(scope), [agent])
  apply(ctx)
  assert.equal(CORDIS_TOOL_NAMES.some(name => definitions.has(name)), true)

  scope.set({ enabled: true, cordisToolsEnabled: false })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(CORDIS_TOOL_NAMES.some(name => definitions.has(name)), false)

  scope.set({ enabled: true, cordisToolsEnabled: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(CORDIS_TOOL_NAMES.some(name => definitions.has(name)), true)
  for (const cleanup of cleanups.reverse()) await cleanup()
})

test('keeps Cordis and settings atomic when an active worker rejects reconfiguration', async () => {
  for (const initiallyEnabled of [false, true]) {
    const scope = settingsScope({
      enabled: true,
      cordisToolsEnabled: initiallyEnabled,
      maxOldGenerationSizeMb: 64,
    })
    const cordis = cordisAgent()
    const host = hostContext(settingsContext(scope), [cordis.agent])
    apply(host.ctx)
    await openSessionWorker(host, cordis.agent)

    scope.set({
      ...scope.get(),
      cordisToolsEnabled: !initiallyEnabled,
      maxOldGenerationSizeMb: 128,
    })
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(scope.get().cordisToolsEnabled, initiallyEnabled)
    assert.equal(scope.get().maxOldGenerationSizeMb, 64)
    assert.equal(
      CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)),
      initiallyEnabled,
    )
    assert.equal(cordis.pluginCalls, initiallyEnabled ? 1 : 0)
    assert.equal(host.ctx.logger.warnings.length > 0, true)
    for (const cleanup of host.cleanups.reverse()) await cleanup()
  }
})

test('rolls back a failed live Cordis reconfiguration', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: false })
  const agent = cordisAgent(undefined, { missingServices: true })
  agent.agent.ctx.get = () => undefined
  const host = hostContext(settingsContext(scope), [agent.agent])
  apply(host.ctx)
  scope.set({ enabled: true, cordisToolsEnabled: true })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().cordisToolsEnabled, false)
  assert.equal(Object.hasOwn(host.runtime, 'run'), true)
  assert.equal(host.ctx.logger.warnings.length > 0, true)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('restores Cordis after a rejecting live Cordis disposal', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, { throwDispose: true })
  const host = hostContext(settingsContext(scope), [cordis.agent])
  apply(host.ctx)
  scope.set({ enabled: true, cordisToolsEnabled: false })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().cordisToolsEnabled, true)
  assert.equal(CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), true)
  for (const cleanup of host.cleanups.reverse()) {
    try { await cleanup() } catch {}
  }
})

test('surfaces a live configuration rollback write failure', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: false })
  scope.update = async () => { throw new Error('settings offline') }
  const agent = cordisAgent()
  agent.agent.ctx.get = () => undefined
  const host = hostContext(settingsContext(scope), [agent.agent])
  apply(host.ctx)
  scope.set({ enabled: true, cordisToolsEnabled: true })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.ctx.logger.warnings.length >= 2, true)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('does not roll back a newer live update after an older update fails', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, { disposeFailures: 1 })
  const host = hostContext(settingsContext(scope), [cordis.agent])
  apply(host.ctx)

  scope.set({ enabled: true, cordisToolsEnabled: false })
  scope.set({ enabled: true, cordisToolsEnabled: false, tipsEnabled: false })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(scope.get().cordisToolsEnabled, false)
  assert.equal(scope.get().tipsEnabled, false)
  assert.equal(CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
  assert.equal(host.ctx.logger.warnings.length > 0, true)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('serializes re-enable behind a pending Cordis teardown', async () => {
  let releaseTeardown
  const teardown = new Promise(resolve => { releaseTeardown = resolve })
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(teardown)
  const { agent, definitions } = cordis
  const { ctx, cleanups } = hostContext(settingsContext(scope), [agent])
  apply(ctx)

  assert.equal(cordis.pluginCalls, 1)
  assert.deepEqual(
    CORDIS_TOOL_NAMES.filter(name => definitions.has(name)),
    CORDIS_TOOL_NAMES,
  )

  scope.set({ enabled: false, cordisToolsEnabled: true })
  scope.set({ enabled: false, cordisToolsEnabled: true })
  scope.set({ enabled: true, cordisToolsEnabled: true })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(cordis.pluginCalls, 1)
  assert.deepEqual(
    CORDIS_TOOL_NAMES.filter(name => definitions.has(name)),
    CORDIS_TOOL_NAMES,
  )

  releaseTeardown()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(cordis.pluginCalls, 2)
  assert.deepEqual(
    CORDIS_TOOL_NAMES.filter(name => definitions.has(name)),
    CORDIS_TOOL_NAMES,
  )

  scope.set({ enabled: false, cordisToolsEnabled: true })
  scope.set({ enabled: true, cordisToolsEnabled: true })
  scope.set({ enabled: false, cordisToolsEnabled: true })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(cordis.pluginCalls, 3)
  assert.equal(CORDIS_TOOL_NAMES.some(name => definitions.has(name)), false)

  for (const cleanup of cleanups.reverse()) await cleanup()
})

test('rolls back a queued live enable when installation rejects asynchronously', async () => {
  let releaseTeardown
  const teardown = new Promise(resolve => { releaseTeardown = resolve })
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(teardown)
  const options = {}
  const host = hostContext(settingsContext(scope), [cordis.agent], options)
  apply(host.ctx)

  scope.set({ enabled: false, cordisToolsEnabled: true })
  options.failPromptSection = true
  scope.set({ enabled: true, cordisToolsEnabled: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cordis.pluginCalls, 1)

  releaseTeardown()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().enabled, false)
  assert.equal(Object.hasOwn(host.runtime, 'run'), false)
  assert.equal(CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
  assert.equal(host.ctx.logger.warnings.length > 0, true)

  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('config schema defaults expose the settings switches', async () => {
  const defaults = await Config['~standard'].validate({})
  assert.equal(defaults.value.enabled, true)
  assert.equal(defaults.value.cordisToolsEnabled, false)
  const invalid = await Config['~standard'].validate({ enabled: 'yes' })
  assert.equal(invalid.issues[0].path[0], 'enabled')
  const ns = await Config['~standard'].validate({ enabled: false })
  assert.equal(ns.value.enabled, false)
  const cordis = await Config['~standard'].validate({ cordisToolsEnabled: true })
  assert.equal(cordis.value.cordisToolsEnabled, true)
})

test('runtime config rejects an invalid enabled value', () => {
  assert.throws(() => resolveConfig({ enabled: 'yes' }), /enabled must be a boolean/)
  assert.throws(() => resolveConfig({ cordisToolsEnabled: 'yes' }), /cordisToolsEnabled must be a boolean/)
})
