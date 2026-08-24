import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CORDIS_TOOL_NAMES,
  createCordisToolsOwner,
} from '../internal/cordis-tools-owner.js'

const fakeCordisPlugin = {
  name: 'fake-tool-cordis',
  apply(ctx) {
    for (const name of CORDIS_TOOL_NAMES) ctx.tools.register({ name })
  },
}

function scopedAgent(id, options = {}) {
  const definitions = new Map()
  if (options.ptc !== false) definitions.set('run_code', { name: 'run_code' })
  for (const name of options.existingTools ?? []) definitions.set(name, { name })
  const services = new Map([
    ['dynamicCordisRunner', {}],
    ['cordisInspect', {}],
  ])
  for (const missing of options.missingServices ?? []) services.delete(missing)
  let pluginCalls = 0
  const ctx = {
    tools: {
      get(name) {
        return definitions.get(name)
      },
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
    get(name) {
      return services.get(name)
    },
    plugin(plugin) {
      pluginCalls += 1
      const before = new Set(definitions.keys())
      if (options.activate !== false) plugin.apply(ctx)
      if (options.invalidFiber) return {}
      return {
        async dispose() {
          for (const name of definitions.keys()) {
            if (!before.has(name)) definitions.delete(name)
          }
          if (options.throwDispose === true) throw new Error('Cordis disposal failed')
        },
      }
    },
  }
  if (options.withoutGet) delete ctx.get
  if (options.withoutPlugin) delete ctx.plugin
  return {
    id,
    ctx,
    definitions,
    get pluginCalls() {
      return pluginCalls
    },
  }
}

function ownerContext(initialAgents = []) {
  const listeners = new Map()
  const warnings = []
  return {
    ctx: {
      agents: { list: () => initialAgents },
      on(name, listener) {
        const entries = listeners.get(name) ?? []
        entries.push(listener)
        listeners.set(name, entries)
        return () => entries.splice(entries.indexOf(listener), 1)
      },
      logger: { warn(message, error) { warnings.push([message, error]) } },
    },
    warnings,
    async emit(name, payload) {
      for (const listener of [...listeners.get(name) ?? []]) await listener(payload)
    },
  }
}

test('Cordis owner scopes official tools to current and future PTC agents', async () => {
  const current = scopedAgent('current')
  const native = scopedAgent('native', { ptc: false })
  const host = ownerContext([current, native])
  const owner = createCordisToolsOwner(host.ctx, fakeCordisPlugin)

  assert.equal(current.pluginCalls, 1)
  assert.equal(native.pluginCalls, 0)
  assert.deepEqual(CORDIS_TOOL_NAMES.filter(name => current.definitions.has(name)), CORDIS_TOOL_NAMES)

  const future = scopedAgent('future')
  await host.emit('agent/created', { agent: future })
  await host.emit('agent/created', { agent: future })
  assert.equal(future.pluginCalls, 1)

  await host.emit('agent/disposed', { agent: native })
  await host.emit('agent/disposed', { agent: future })
  assert.equal(CORDIS_TOOL_NAMES.some(name => future.definitions.has(name)), false)

  await owner.dispose()
  assert.equal(CORDIS_TOOL_NAMES.some(name => current.definitions.has(name)), false)
})

test('Cordis owner retries agents once run_code becomes visible', async () => {
  const late = scopedAgent('late', { ptc: false })
  const host = ownerContext([late])
  const owner = createCordisToolsOwner(host.ctx, fakeCordisPlugin)
  assert.equal(late.pluginCalls, 0)

  late.definitions.set('run_code', { name: 'run_code' })
  await host.emit('tools/change')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(late.pluginCalls, 1)
  assert.deepEqual(CORDIS_TOOL_NAMES.filter(name => late.definitions.has(name)), CORDIS_TOOL_NAMES)
  await owner.dispose()
})

test('Cordis owner diagnoses a deferred activation failure', async () => {
  const late = scopedAgent('late-missing-services', {
    ptc: false,
    missingServices: ['dynamicCordisRunner'],
  })
  const host = ownerContext([late])
  const owner = createCordisToolsOwner(host.ctx, fakeCordisPlugin)
  late.definitions.set('run_code', { name: 'run_code' })
  await host.emit('tools/change')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(late.pluginCalls, 0)
  assert.equal(host.warnings.length, 1)
  await owner.dispose()
})

test('Cordis owner accepts an already complete agent-owned surface', async () => {
  const agent = scopedAgent('existing', { existingTools: CORDIS_TOOL_NAMES })
  const host = ownerContext([agent])
  const owner = createCordisToolsOwner(host.ctx, fakeCordisPlugin)
  assert.equal(agent.pluginCalls, 0)
  await owner.dispose()
})

test('Cordis owner rejects incompatible host and agent capabilities', () => {
  assert.throws(
    () => createCordisToolsOwner({ agents: {}, on() {} }, fakeCordisPlugin),
    /agents\.list API/,
  )

  const missingGet = scopedAgent('missing-get', { withoutGet: true })
  assert.throws(
    () => createCordisToolsOwner(ownerContext([missingGet]).ctx, fakeCordisPlugin),
    /Context\.get API/,
  )

  const missingServices = scopedAgent('missing-services', {
    missingServices: ['dynamicCordisRunner', 'cordisInspect'],
  })
  assert.throws(
    () => createCordisToolsOwner(ownerContext([missingServices]).ctx, fakeCordisPlugin),
    /dynamicCordisRunner, cordisInspect/,
  )

  const partial = scopedAgent('partial', { existingTools: [CORDIS_TOOL_NAMES[0]] })
  assert.throws(
    () => createCordisToolsOwner(ownerContext([partial]).ctx, fakeCordisPlugin),
    /partial Cordis tool surface/,
  )

  const missingPlugin = scopedAgent('missing-plugin', { withoutPlugin: true })
  assert.throws(
    () => createCordisToolsOwner(ownerContext([missingPlugin]).ctx, fakeCordisPlugin),
    /Context\.plugin API/,
  )

  const invalidFiber = scopedAgent('invalid-fiber', { invalidFiber: true })
  assert.throws(
    () => createCordisToolsOwner(ownerContext([invalidFiber]).ctx, fakeCordisPlugin),
    /did not return a disposable Cordis fiber/,
  )
})

test('Cordis owner fails the first request when the official plugin stays pending', async () => {
  const agent = scopedAgent('pending', { activate: false })
  assert.throws(
    () => createCordisToolsOwner(ownerContext([agent]).ctx, fakeCordisPlugin),
    /must be available before the first request/,
  )
  await new Promise(resolve => setImmediate(resolve))
})

test('Cordis owner rolls back earlier current-agent mounts after a later conflict', async () => {
  const mounted = scopedAgent('mounted')
  const conflict = scopedAgent('conflict', { existingTools: [CORDIS_TOOL_NAMES[0]] })
  assert.throws(
    () => createCordisToolsOwner(ownerContext([mounted, conflict]).ctx, fakeCordisPlugin),
    /partial Cordis tool surface/,
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(CORDIS_TOOL_NAMES.some(name => mounted.definitions.has(name)), false)
})

test('Cordis rollback contains rejecting fiber disposers', async () => {
  const mounted = scopedAgent('mounted-rejecting', { throwDispose: true })
  const conflict = scopedAgent('conflict-after-rejecting', { existingTools: [CORDIS_TOOL_NAMES[0]] })
  const host = ownerContext([mounted, conflict])
  assert.throws(
    () => createCordisToolsOwner(host.ctx, fakeCordisPlugin),
    /partial Cordis tool surface/,
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.warnings.length, 1)
  assert.equal(CORDIS_TOOL_NAMES.some(name => mounted.definitions.has(name)), false)
})
