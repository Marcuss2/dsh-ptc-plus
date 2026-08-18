import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { Include } from '@deepseek-ai/cordis-plugin-include'
import { apply as applyOmnipotent } from '../omnipotent-preset.js'
import { apply as applyRoster, mergePresetRosters } from '../preset-roster.js'

test('adds one package-owned system preset through the official dynamic roster', async () => {
  const effects = []
  const official = [{ id: 'standard' }, { id: 'cordis' }]
  const service = { async list() { return official } }
  const originalList = service.list
  applyRoster({
    agentPresets: service,
    effect(register) { effects.push(register()) },
  })

  const discovered = await service.list()
  assert.deepEqual(discovered.slice(0, 2), official)
  assert.deepEqual(discovered.slice(2).map(({ id, name, description, order, trust, broken }) => ({
    id, name, description, order, trust, broken,
  })), [{
    id: 'omnipotent',
    name: '全能模式',
    description: '完整继承当前官方创造模式能力，并以 PTC REPL 和无审批全权限运行。',
    order: 5,
    trust: 'system',
    broken: undefined,
  }])

  await effects[0]()
  assert.equal(service.list, originalList)
  assert.equal((await service.list()).length, 2)
})

test('keeps an upstream preset ahead of a colliding package preset', () => {
  const upstream = [{ id: 'omnipotent', name: 'deployment-owned' }]
  const additions = [{ id: 'omnipotent', name: 'package-owned' }, { id: 'extra' }]
  assert.deepEqual(mergePresetRosters(upstream, additions), [upstream[0], additions[1]])
})

test('is inert when the host profile has no preset roster', () => {
  assert.doesNotThrow(() => applyRoster({ get() { return undefined } }))
})

test('becomes a passthrough when a later roster decorator owns teardown', async () => {
  const effects = []
  const service = { async list() { return [{ id: 'standard' }] } }
  applyRoster({
    agentPresets: service,
    effect(register) { effects.push(register()) },
  })
  const ptcPlusList = service.list
  service.list = async () => [...await ptcPlusList(), { id: 'later' }]

  await effects[0]()
  assert.deepEqual((await service.list()).map(preset => preset.id), ['standard', 'later'])
})

test('mounts the current official Cordis composition as code with full permission', async () => {
  const listeners = new Map()
  const permissionCalls = []
  let mounted
  const ctx = {
    agentPresets: {
      async resolve(id) {
        assert.equal(id, 'cordis')
        return { id, path: '/official/cordis/agent.cordis.yml' }
      },
    },
    permissionPresets: {
      set(session, preset) {
        permissionCalls.push([session, preset])
      },
    },
    on(name, listener) {
      listeners.set(name, listener)
    },
    async plugin(plugin, config) {
      mounted = { plugin, config }
    },
  }

  await applyOmnipotent(ctx)
  assert.equal(mounted.plugin.prototype instanceof Include, true)
  assert.equal(mounted.plugin.prototype.write(), undefined)
  assert.deepEqual(mounted.config, {
    path: pathToFileURL('/official/cordis/agent.cordis.yml').href,
    patches: [{
      insert: [{
        id: 'tool-presentation',
        name: '@deepseek-ai/dsh-agent-tool-presentation',
        config: { mode: 'code' },
      }],
    }],
  })

  const createdSession = { id: 'created' }
  listeners.get('agent/created')({ agent: { session: createdSession } })
  const selectedSession = { id: 'selected' }
  let publishing = true
  const setPermission = ctx.permissionPresets.set
  ctx.permissionPresets.set = (session, preset) => {
    assert.equal(publishing, false, 'permission writes must run after session/event publication')
    setPermission(session, preset)
  }
  listeners.get('session/event')(selectedSession, {
    type: 'agent-preset/selected',
    data: { agentPreset: 'omnipotent' },
  })
  listeners.get('session/event')({ id: 'other' }, {
    type: 'agent-preset/selected',
    data: { agentPreset: 'standard' },
  })
  assert.deepEqual(permissionCalls, [[createdSession, 'danger-full-access']])
  publishing = false
  await new Promise(resolve => { queueMicrotask(resolve) })
  assert.deepEqual(permissionCalls, [
    [createdSession, 'danger-full-access'],
    [selectedSession, 'danger-full-access'],
  ])
})

test('refuses to mount a broken official Cordis preset', async () => {
  const ctx = {
    agentPresets: { resolve: async () => ({ broken: 'invalid composition' }) },
    permissionPresets: {},
    on() { throw new Error('listeners must not register') },
    plugin() { throw new Error('composition must not mount') },
  }
  await assert.rejects(applyOmnipotent(ctx), /official cordis preset is broken: invalid composition/)
})
