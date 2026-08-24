import * as CordisTools from '@deepseek-ai/dsh-tool-cordis'
import { RUN_CODE } from './runtime-bridge-owner.js'

/** Tool names owned by the official DSH Cordis tool plugin. */
export const CORDIS_TOOL_NAMES = Object.freeze([
  'cordis_inspect_list',
  'cordis_inspect_query',
  'cordis_inspect_self',
  'cordis_define',
  'cordis_run',
  'cordis_stop',
  'cordis_undefine',
])

const REQUIRED_SERVICES = Object.freeze([
  'dynamicCordisRunner',
  'cordisInspect',
])

function availableTools(agent) {
  return CORDIS_TOOL_NAMES.filter(name => agent.ctx.tools.get(name, agent) !== undefined)
}

function requireCordisServices(agent) {
  if (typeof agent?.ctx?.get !== 'function') {
    throw new Error('ptc-plus: cordisToolsEnabled requires the DSH agent Context.get API')
  }
  const missing = REQUIRED_SERVICES.filter(service => agent.ctx.get(service) === undefined)
  if (missing.length > 0) {
    throw new Error(
      `ptc-plus: cordisToolsEnabled requires DSH services: ${missing.join(', ')}`,
    )
  }
}

/** Own the official Cordis plugin fibers mounted in PTC agent scopes. */
export function createCordisToolsOwner(ctx, cordisPlugin = CordisTools) {
  if (typeof ctx?.agents?.list !== 'function') {
    throw new Error('ptc-plus: cordisToolsEnabled requires the DSH agents.list API')
  }
  const installed = new Map()
  const pending = new Set()
  let disposed = false

  const reportDisposalFailure = (error) => {
    ctx.logger?.warn?.('ptc-plus: Cordis rollback disposal failed', error)
  }

  const disposeFiberSafely = (fiber) => Promise.resolve()
    .then(() => fiber.dispose())
    .catch(error => {
      reportDisposalFailure(error)
    })

  const disposeAgent = async (agent) => {
    pending.delete(agent)
    const fiber = installed.get(agent)
    if (fiber === undefined) return
    installed.delete(agent)
    await fiber.dispose()
  }

  const installAgent = (agent) => {
    if (disposed || installed.has(agent)) return
    if (agent?.ctx?.tools?.get?.(RUN_CODE, agent) === undefined) {
      pending.add(agent)
      return
    }
    pending.delete(agent)
    const existing = availableTools(agent)
    if (existing.length === CORDIS_TOOL_NAMES.length) return
    if (existing.length > 0) {
      throw new Error(
        `ptc-plus: cannot enable Cordis tools for agent ${JSON.stringify(String(agent.id))}; `
        + `the scope already contains a partial Cordis tool surface: ${existing.join(', ')}`,
      )
    }
    requireCordisServices(agent)
    if (typeof agent.ctx.plugin !== 'function') {
      throw new Error('ptc-plus: cordisToolsEnabled requires the DSH agent Context.plugin API')
    }
    const fiber = agent.ctx.plugin(cordisPlugin)
    if (typeof fiber?.dispose !== 'function') {
      throw new Error('ptc-plus: DSH Context.plugin did not return a disposable Cordis fiber')
    }
    const missingTools = CORDIS_TOOL_NAMES.filter(
      name => agent.ctx.tools.get(name, agent) === undefined,
    )
    if (missingTools.length > 0) {
      void disposeFiberSafely(fiber)
      throw new Error(
        `ptc-plus: Cordis tools must be available before the first request; missing: ${missingTools.join(', ')}`,
      )
    }
    installed.set(agent, fiber)
  }

  try {
    for (const agent of ctx.agents.list()) installAgent(agent)
  } catch (error) {
    for (const fiber of installed.values()) void disposeFiberSafely(fiber)
    installed.clear()
    throw error
  }

  const stopCreated = ctx.on('agent/created', ({ agent }) => { installAgent(agent) })
  const stopDisposed = ctx.on('agent/disposed', ({ agent }) => disposeAgent(agent))
  const retryPending = () => {
    if (disposed || pending.size === 0) return
    queueMicrotask(() => {
      if (disposed) return
      for (const agent of [...pending]) {
        try {
          installAgent(agent)
        } catch (error) {
          pending.delete(agent)
          ctx.logger?.warn?.('ptc-plus: deferred Cordis activation failed', error)
        }
      }
    })
  }
  const stopToolsChange = ctx.on('tools/change', retryPending)

  return Object.freeze({
    async dispose() {
      disposed = true
      stopDisposed()
      stopCreated()
      stopToolsChange()
      pending.clear()
      const fibers = [...installed.values()]
      installed.clear()
      const results = await Promise.allSettled(fibers.map(fiber => fiber.dispose()))
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'ptc-plus Cordis disposal failed')
    },
  })
}
