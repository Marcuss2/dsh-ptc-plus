import { apply } from '../index.js'

export const JOURNAL_POLICY = { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true }

export function appendOnlySession(id, events = []) {
  return {
    id,
    get events() {
      return Object.freeze([...events])
    },
    append(type, data) {
      const event = Object.freeze({
        type,
        seq: events.length,
        time: events.length,
        data: structuredClone(data),
      })
      events.push(event)
      return event
    },
  }
}

export function ptcAgent(id, session = { id, events: [] }) {
  const presentation = { mode: undefined, calls: [], disposals: 0 }
  const registration = { calls: [], disposals: 0 }
  const definitions = new Map()
  let inheritedGet = () => undefined
  let inheritedSchemas = () => []
  let agent
  const tools = {
    bindFixtureRegistry(get, schemas) {
      inheritedGet = get
      inheritedSchemas = schemas
    },
    get(name) {
      return definitions.get(name) ?? inheritedGet(name)
    },
    schemas(scope) {
      const inherited = inheritedSchemas(scope).filter(definition => !definitions.has(definition.name))
      return scope === agent ? [...inherited, ...definitions.values()] : inherited
    },
    register(definition) {
      if (definitions.has(definition.name)) throw new Error(`duplicate scoped tool ${definition.name}`)
      definitions.set(definition.name, definition)
      registration.calls.push(definition.name)
      let active = true
      return () => {
        if (!active) return
        active = false
        if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
        registration.disposals += 1
      }
    },
    presentAs(mode) {
      if (presentation.mode !== undefined) {
        throw new Error(`presentation already declared as ${presentation.mode}`)
      }
      presentation.mode = mode
      presentation.calls.push(mode)
      let active = true
      return () => {
        if (!active) return
        active = false
        presentation.mode = undefined
        presentation.disposals += 1
      }
    },
  }
  agent = {
    id,
    session,
    presentation,
    registration,
    ctx: {
      tools,
    },
  }
  return agent
}

export function fixture(config = {}, fixtureOptions = {}) {
  const listeners = new Map()
  const listenerOptions = new Map()
  const cleanups = []
  let disposal
  const sections = []
  const upstreamCalls = []
  let nextCallId = 0
  const runCodeDefinition = {
    name: 'run_code',
    description: 'Execute one standalone program.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', description: 'Standalone program source.' },
        description: { type: 'string', description: 'Program summary.' },
      },
      required: ['code', 'description'],
    },
    output: {},
  }
  const definitions = new Map([['run_code', runCodeDefinition]])
  const runtime = {
    language: 'typescript',
    isolation: 'worker-thread',
    async run(request) {
      upstreamCalls.push(request)
      if (fixtureOptions.upstreamRun !== undefined) return fixtureOptions.upstreamRun(request)
      return { logs: ['upstream'], value: 'upstream' }
    },
  }
  const ctx = {
    codeRuntime: runtime,
    tools: {
      get: (name, scope) => scope?.ctx?.tools?.get(name) ?? definitions.get(name),
      register(definition) {
        definitions.set(definition.name, definition)
        return () => {
          if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
        }
      },
      async execute(options) {
        const definition = options.agent?.ctx?.tools?.get(options.name) ?? definitions.get(options.name)
        if (options.name === 'run_code') {
          const observed = await executeRun(
            options.agent?.id,
            options.arguments.code,
            options.bindings ?? {},
            { session: options.agent?.session, callId: options.callId },
          )
          return observed.result
        }
        const dispatch = async () => {
          if (definition === undefined || typeof definition.execute !== 'function') {
            return { isError: true, content: [], error: { message: `unknown tool ${options.name}` } }
          }
          try {
            const value = await definition.execute(options.arguments, options)
            return { isError: false, value, content: [], meta: definition.output?.presentationMeta?.(options.arguments, value) }
          } catch (error) {
            return { isError: true, content: [], error: { message: error.message } }
          }
        }
        const execute = listeners.get('tools/execute')?.[0]
        const result = execute === undefined ? await dispatch() : await execute(options, dispatch)
        for (const listener of listeners.get('tools/result') ?? []) await listener(options, result)
        return result
      },
      schemas: scope => typeof scope?.ctx?.tools?.schemas === 'function'
        ? scope.ctx.tools.schemas(scope)
        : [...definitions.values(), ...(fixtureOptions.schemas ?? [])],
    },
    ...(fixtureOptions.agents === undefined ? {} : { agents: fixtureOptions.agents }),
    systemPrompt: {
      section(value) {
        sections.push(value)
        return () => sections.splice(sections.indexOf(value), 1)
      },
    },
    on(name, listener, options) {
      const entries = listeners.get(name) ?? []
      entries.push(listener)
      listeners.set(name, entries)
      listenerOptions.set(listener, options)
      return () => entries.splice(entries.indexOf(listener), 1)
    },
    effect(register) {
      cleanups.push(register())
    },
  }
  apply(ctx, {
    computeMs: 500,
    maxWallMs: 2_000,
    maxOldGenerationSizeMb: 64,
    ...config,
  })

  async function executeRun(session, program, functions, options) {
    const execute = listeners.get('tools/execute')[0]
    const controller = options.controller ?? new AbortController()
    const exec = {
      name: 'run_code',
      callId: options.callId ?? `fixture-call-${++nextCallId}`,
      agent: { id: session, session: options.session },
    }
    let raw
    let result = await execute(exec, async () => {
      raw = await runtime.run({
        program,
        bindings: [{
          global: 'tools',
          functions,
          errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
        }, ...(options.bindings ?? [])],
        signal: controller.signal,
      })
      const meta = runCodeDefinition.output.presentationMeta?.({}, raw.value)
      if (raw.error) {
        return { isError: true, content: [], error: { message: raw.error.message }, meta }
      }
      return { isError: false, value: raw.value, content: [], meta }
    })
    if (options.finalizeResult !== undefined) result = options.finalizeResult(result)
    for (const listener of listeners.get('tools/result') ?? []) await listener(exec, result)
    return { raw, result }
  }

  async function run(session, program, functions = {}, options = {}) {
    return (await executeRun(session, program, functions, options)).raw
  }

  async function runDurable(session, program, functions = {}, options = {}) {
    return (await executeRun(session, program, functions, options)).result
  }

  async function rejectBeforeRuntime(session, options = {}) {
    const execute = listeners.get('tools/execute')[0]
    const exec = {
      name: 'run_code',
      callId: options.callId ?? `fixture-call-${++nextCallId}`,
      agent: { id: session, session: options.session },
    }
    let result = await execute(exec, async () => ({
      isError: true,
      content: [],
      error: { message: options.message ?? 'rejected before runtime dispatch' },
    }))
    if (options.finalizeResult !== undefined) result = options.finalizeResult(result)
    for (const listener of listeners.get('tools/result') ?? []) await listener(exec, result)
    return result
  }

  async function assemble(assembly, context = {}, next = async () => assembly) {
    context.agent?.ctx?.tools?.bindFixtureRegistry?.(
      name => definitions.get(name),
      scope => [
        ...definitions.values(),
        ...(fixtureOptions.schemas ?? []),
        ...(scope === context.agent ? fixtureOptions.scopedSchemas ?? [] : []),
      ],
    )
    const listener = listeners.get('system-prompt/assemble')?.[0]
    return listener === undefined ? next() : listener(assembly, context, next)
  }

  async function stream(options, chunks) {
    const listener = listeners.get('llm/stream')?.[0]
    const source = async function* () { yield* chunks }
    const output = []
    const transformed = listener === undefined ? source() : listener(options, source)
    for await (const chunk of transformed) output.push(chunk)
    return output
  }

  async function dispatchNestedRun(session, args, options = {}) {
    const execute = listeners.get('tools/execute')[0]
    const controller = options.controller ?? new AbortController()
    const exec = {
      name: 'run_code',
      callId: options.callId ?? `fixture-nested-${++nextCallId}`,
      rootCallId: options.rootCallId ?? 'fixture-root',
      parent: options.parent ?? { id: 'fixture-parent-token' },
      agent: { id: session, session: options.session },
    }
    let result = await execute(exec, async () => {
      const raw = await runtime.run({ program: args.code, bindings: options.bindings ?? [], signal: controller.signal })
      if (raw.error !== undefined) {
        return { isError: true, content: [], error: { message: raw.error.message } }
      }
      return {
        isError: false,
        content: [],
        value: { logs: raw.logs, ...(raw.value === undefined ? {} : { result: raw.value }) },
      }
    })
    if (options.finalizeResult !== undefined) result = options.finalizeResult(result)
    for (const listener of listeners.get('tools/result') ?? []) await listener(exec, result)
    return result
  }

  return {
    ctx,
    listeners,
    listenerOptions,
    runtime,
    runCodeDefinition,
    sections,
    upstreamCalls,
    assemble,
    stream,
    dispatchNestedRun,
    executeRun,
    rejectBeforeRuntime,
    runDurable,
    run,
    async emit(name, value) {
      await Promise.all((listeners.get(name) ?? []).map(listener => listener(value)))
    },
    async dispose() {
      disposal ??= (async () => {
        while (cleanups.length > 0) await cleanups.pop()()
      })()
      await disposal
    },
  }
}

export function appendRunCodeEvents(events, callId, code, result, description = 'test cell') {
  const callSeq = events.length
  events.push({
    type: 'tool/call',
    seq: callSeq,
    time: callSeq,
    data: {
      turn: 0,
      step: 0,
      callId,
      name: 'run_code',
      arguments: JSON.stringify({ code, description }),
    },
  })
  events.push({
    type: 'tool/result',
    seq: callSeq + 1,
    time: callSeq + 1,
    sourceEventSeqs: [callSeq],
    surfaceOp: 'append',
    data: {
      message: {
        id: `message-${callId}`,
        role: 'tool',
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [] }],
      },
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    },
  })
}
