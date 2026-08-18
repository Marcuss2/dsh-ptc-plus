import { fileURLToPath } from 'node:url'
import { discoverPresets } from '@deepseek-ai/dsh-agent-presets'

const PRESET_ROOT = Object.freeze({
  path: fileURLToPath(new URL('./presets/', import.meta.url)),
  trust: 'system',
})

export function mergePresetRosters(upstream, additions) {
  const ids = new Set(upstream.map(preset => preset.id))
  return [...upstream, ...additions.filter(preset => !ids.has(preset.id))]
}

/** Add package-owned presets while leaving discovery and mounting with RC7. */
export function apply(ctx) {
  const service = typeof ctx.get === 'function' ? ctx.get('agentPresets') : ctx.agentPresets
  if (service === undefined) return
  const ownList = Object.getOwnPropertyDescriptor(service, 'list')
  const upstreamList = service.list.bind(service)
  let active = true
  const list = async () => {
    const upstream = await upstreamList()
    return active
      ? mergePresetRosters(upstream, await discoverPresets([PRESET_ROOT]))
      : upstream
  }

  Object.defineProperty(service, 'list', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: list,
  })
  ctx.effect(() => () => {
    active = false
    if (Object.getOwnPropertyDescriptor(service, 'list')?.value !== list) return
    if (ownList === undefined) delete service.list
    else Object.defineProperty(service, 'list', ownList)
  }, 'ptc-plus preset roster teardown')
}
