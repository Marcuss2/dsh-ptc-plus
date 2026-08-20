/** Deterministic capability metadata derived from the current DSH tool view. */

const COMPLETENESS = new Set(['complete', 'bounded', 'incremental', 'open-world', 'unknown'])
const SOURCE_KINDS = new Set(['authored', 'runtime', 'tests', 'docs'])
const REPLAY = new Set(['recorded-value', 'owner-replay', 'volatile', 'unknown'])

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`ptc-plus: ${label} must be an object`)
  }
  return value
}

function text(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`ptc-plus: ${label} must be a non-empty string`)
  }
  return value
}

function metadataSnapshot(value, label) {
  let clone
  try {
    clone = structuredClone(value)
  } catch (error) {
    throw new TypeError(`ptc-plus: ${label} must be structured data: ${error.message}`)
  }
  if (clone === null || typeof clone !== 'object') return clone
  const pending = [clone]
  const seen = new Set()
  while (pending.length > 0) {
    const current = pending.pop()
    if (seen.has(current)) continue
    seen.add(current)
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === 'object') pending.push(child)
    }
    Object.freeze(current)
  }
  return clone
}

function sourceRef(value, label) {
  if (value === undefined) return undefined
  const source = record(value, label)
  const kind = text(source.kind, `${label}.kind`)
  if (!SOURCE_KINDS.has(kind)) throw new TypeError(`ptc-plus: ${label}.kind is invalid`)
  const path = text(source.path, `${label}.path`)
  const result = { kind, path }
  if (source.symbol !== undefined) result.symbol = text(source.symbol, `${label}.symbol`)
  if (source.revision !== undefined) result.revision = text(source.revision, `${label}.revision`)
  return Object.freeze(result)
}

/** Convert DSH's live tool schemas into descriptive metadata without wrapping invocation. */
export function toolCapabilityMetadata(schemas, annotations = {}) {
  if (!Array.isArray(schemas)) throw new TypeError('ptc-plus: tool schemas must be an array')
  const overrides = record(annotations, 'tool annotations')
  const members = schemas
    .filter(schema => schema?.name !== 'run_code')
    .map((schema) => {
      const value = record(schema, 'tool schema')
      const name = text(value.name, 'tool schema name')
      const annotation = overrides[name] === undefined ? {} : record(overrides[name], `${name} annotation`)
      return Object.freeze({
        name,
        ...(value.description === undefined ? {} : { description: text(value.description, `${name} description`) }),
        parameters: metadataSnapshot(value.parameters ?? {}, `${name} parameters`),
        returns: metadataSnapshot(value.output ?? {}, `${name} output`),
        effect: annotation.effect ?? 'unknown',
        authority: annotation.authority ?? 'dsh-tool-dispatch',
        completeness: annotation.completeness ?? 'unknown',
        replay: annotation.replay ?? 'unknown',
        ...(annotation.sourceRef === undefined ? {} : { sourceRef: sourceRef(annotation.sourceRef, `${name} sourceRef`) }),
        ...(annotation.revision === undefined ? {} : { revision: text(annotation.revision, `${name} revision`) }),
        ...(annotation.fingerprint === undefined ? {} : { fingerprint: text(annotation.fingerprint, `${name} fingerprint`) }),
      })
    })
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const member of members) {
    if (!COMPLETENESS.has(member.completeness)) {
      throw new TypeError(`ptc-plus: ${member.name}.completeness is invalid`)
    }
    if (!REPLAY.has(member.replay)) {
      throw new TypeError(`ptc-plus: ${member.name}.replay is invalid`)
    }
  }
  return Object.freeze([{ namespace: 'tools', members: Object.freeze(members) }])
}

function metadataEntries(metadata) {
  if (!Array.isArray(metadata)) throw new TypeError('ptc-plus: capability metadata must be an array')
  return metadata.map((entry) => {
    const value = record(entry, 'capability metadata entry')
    const namespace = text(value.namespace, 'capability namespace')
    const members = Array.isArray(value.members)
      ? value.members.map((member) => {
          const item = record(member, 'capability member')
          return { ...item, name: text(item.name, `${namespace} capability member name`) }
        })
      : []
    return { ...value, namespace, members }
  })
}

/** Deterministic hierarchy only. Details remain behind inspect. */
export function capabilityTree(metadata) {
  return metadataEntries(metadata).map((value) => {
    return {
      namespace: value.namespace,
      members: value.members.map(member => member.name),
      ...(value.revision === undefined ? {} : { revision: value.revision }),
      ...(value.fingerprint === undefined ? {} : { fingerprint: value.fingerprint }),
    }
  })
}

/** Find lightweight candidates without returning full schemas or source. */
export function capabilityFind(metadata, query) {
  const needle = text(query, 'capability query').toLowerCase()
  return metadataEntries(metadata).flatMap(entry => entry.members.flatMap((member) => {
    const symbol = `${entry.namespace}.${member.name}`
    const haystack = `${symbol} ${member.description ?? ''}`.toLowerCase()
    if (!haystack.includes(needle)) return []
    return [{
      symbol,
      ...(member.description === undefined ? {} : { description: member.description }),
      completeness: member.completeness ?? 'unknown',
      effect: member.effect ?? 'unknown',
      replay: member.replay ?? 'unknown',
    }]
  }))
}

/** Batch, budgeted inspection; omitted items remain explicit to the caller. */
export function capabilityInspect(metadata, symbols = undefined, budget = 50) {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new TypeError('ptc-plus: capability inspection budget must be a positive integer')
  const entries = metadataEntries(metadata)
  const requested = symbols === undefined
    ? entries.flatMap(entry => entry.members.map(member => `${entry.namespace}.${member.name}`))
    : symbols
  if (!Array.isArray(requested)) throw new TypeError('ptc-plus: capability symbols must be an array')
  const bySymbol = new Map(entries.flatMap(entry => entry.members.map(member => [
    `${entry.namespace}.${member.name}`,
    { namespace: entry.namespace, ...member },
  ])))
  const selected = requested.slice(0, budget).flatMap((symbol) => {
    const key = text(symbol, 'capability symbol')
    const found = bySymbol.get(key)
    return found === undefined ? [] : [found]
  })
  return {
    symbols: selected,
    omitted: Math.max(0, requested.length - budget),
    unknown: requested.slice(0, budget).filter(symbol => !bySymbol.has(symbol)),
    budget,
  }
}
