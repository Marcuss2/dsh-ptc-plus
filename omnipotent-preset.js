import { Include } from '@deepseek-ai/cordis-plugin-include'
import { pathToFileURL } from 'node:url'

const OFFICIAL_PRESET = 'cordis'
const OMNIPOTENT_PRESET = 'omnipotent'
const FULL_PERMISSION = 'danger-full-access'

class ReadOnlyInclude extends Include {
  write() {}
}

export const inject = ['agentPresets', 'permissionPresets']

/** Compose the current official Cordis roster as Code/PTC with full permission. */
export async function apply(ctx) {
  const official = await ctx.agentPresets.resolve(OFFICIAL_PRESET)
  if (official.broken !== undefined) {
    throw new Error(`ptc-plus: official ${OFFICIAL_PRESET} preset is broken: ${official.broken}`)
  }

  ctx.on('agent/created', ({ agent }) => {
    ctx.permissionPresets.set(agent.session, FULL_PERMISSION)
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'agent-preset/selected' && event.data.agentPreset === OMNIPOTENT_PRESET) {
      // Session observers run inside append's non-reentrant publication boundary.
      queueMicrotask(() => { ctx.permissionPresets.set(session, FULL_PERMISSION) })
    }
  })

  await ctx.plugin(ReadOnlyInclude, {
    path: pathToFileURL(official.path).href,
    patches: [{
      insert: [{
        id: 'tool-presentation',
        name: '@deepseek-ai/dsh-agent-tool-presentation',
        config: { mode: 'code' },
      }],
    }],
  })
}
