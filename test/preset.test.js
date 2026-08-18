import assert from 'node:assert/strict'
import test from 'node:test'
import { apply as applyOmnipotent, composeOmnipotent, projectOfficialToolUnion } from '../omnipotent-preset.js'
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
    description: '动态合并官方标准、创造和极简模式工具，并以 PTC REPL 和无审批全权限运行。',
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
  const registered = []
  const presentationCalls = []
  const mounted = []
  const scopes = Object.fromEntries(['omnipotent', 'cordis', 'standard', 'minimal'].map(id => [id, { id }]))
  const names = {
    omnipotent: ['read', 'cordis_define'],
    cordis: ['read', 'cordis_define'],
    standard: ['read', 'write'],
    minimal: ['run_code', 'bash', 'str_replace_editor'],
  }
  const ctx = {
    agentPresets: {
      async mount(target, id) {
        mounted.push([target, id])
      },
      async standingKeyFor(id) { return scopes[id] },
    },
    tools: {
      schemas(scope) { return names[scope.id].map(name => ({ name })) },
      get(name, scope) {
        if (scope === undefined) return undefined
        return names[scope.id].includes(name) ? { name, source: scope.id } : undefined
      },
      register(definition) {
        registered.push(definition)
        return () => {}
      },
      presentAs(mode) {
        presentationCalls.push(mode)
        return () => {}
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
  }

  await composeOmnipotent(ctx)
  assert.deepEqual(mounted, [[ctx, 'cordis']])
  assert.deepEqual(presentationCalls, ['code'])
  assert.deepEqual(registered.map(definition => definition.name), [
    'write', 'bash', 'str_replace_editor',
  ])

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

test('fails closed when an official schema cannot resolve its definition', async () => {
  const scopes = { cordis: {}, standard: {}, minimal: {} }
  await assert.rejects(projectOfficialToolUnion({
    agentPresets: { async standingKeyFor(id) { return scopes[id] } },
    tools: {
      schemas(scope) { return scope === scopes.cordis ? [{ name: 'missing' }] : [] },
      get() { return undefined },
      register() { throw new Error('must not register an unresolved definition') },
    },
  }, {}), /official cordis tool schema "missing" has no definition/)
})

test('does not duplicate definitions already visible through the inherited scope', async () => {
  const scope = { id: 'cordis' }
  const definition = { name: 'read', source: 'existing' }
  const registered = []
  await projectOfficialToolUnion({
    agentPresets: { async standingKeyFor() { return scope } },
    tools: {
      schemas(requestedScope) {
        return requestedScope === scope ? [{ name: 'read' }] : []
      },
      get(name, requestedScope) {
        return requestedScope === scope ? { name, source: 'official' } : definition
      },
      register(value) { registered.push(value); return () => {} },
    },
  }, scope)
  assert.deepEqual(registered, [])
})

test('fails closed when the official composition cannot join the preset context', async () => {
  const failure = new Error('unscoped composition')
  await assert.rejects(applyOmnipotent({
    agentPresets: { async mount() { throw failure } },
  }), error => error === failure)
})
