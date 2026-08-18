const OFFICIAL_PRESET = 'cordis'
const OFFICIAL_TOOL_PRESETS = Object.freeze(['cordis', 'standard', 'minimal'])
const OMNIPOTENT_PRESET = 'omnipotent'
const FULL_PERMISSION = 'danger-full-access'

export const inject = ['agentPresets', 'permissionPresets', 'tools']

/** Project the deduplicated live tool definitions from every shipped mode. */
export async function projectOfficialToolUnion(ctx, inheritedScope) {
  const visible = new Set(ctx.tools.schemas(inheritedScope).map(schema => schema?.name))
  const definitions = new Map()
  for (const preset of OFFICIAL_TOOL_PRESETS) {
    const scope = await ctx.agentPresets.standingKeyFor(preset)
    for (const schema of ctx.tools.schemas(scope)) {
      if (schema?.name === 'run_code' || visible.has(schema?.name)) continue
      const definition = ctx.tools.get(schema.name, scope)
      if (definition === undefined) {
        throw new Error(`ptc-plus: official ${preset} tool schema ${JSON.stringify(schema.name)} has no definition`)
      }
      definitions.set(schema.name, definition)
      visible.add(schema.name)
    }
  }
  return [...definitions.values()].map(definition => ctx.tools.register(definition))
}

/** Compose the current official Cordis roster as Code/PTC with full permission. */
export async function composeOmnipotent(ctx) {
  await ctx.agentPresets.mount(ctx, OFFICIAL_PRESET)
  const inheritedScope = await ctx.agentPresets.standingKeyFor(OFFICIAL_PRESET)
  ctx.tools.presentAs('code')

  ctx.on('agent/created', ({ agent }) => {
    ctx.permissionPresets.set(agent.session, FULL_PERMISSION)
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'agent-preset/selected' && event.data.agentPreset === OMNIPOTENT_PRESET) {
      // Session observers run inside append's non-reentrant publication boundary.
      queueMicrotask(() => { ctx.permissionPresets.set(session, FULL_PERMISSION) })
    }
  })

  await projectOfficialToolUnion(ctx, inheritedScope)
}

export async function apply(ctx) {
  await composeOmnipotent(ctx)
}
