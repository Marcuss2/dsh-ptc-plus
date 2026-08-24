// Runtime state transitions shared by the session coordinator and cell executor.

export function durabilityState(overrides = {}) {
  return Object.freeze({
    status: 'durable',
    reason: undefined,
    ...overrides,
  })
}

export function transitionDurability(state, transition) {
  if (transition.type !== 'volatile') return state
  return durabilityState({
    ...state,
    status: 'volatile',
    reason: state.reason ?? transition.reason,
  })
}

export class BindingCatalog {
  #known
  #imports
  #namespaces

  constructor(known = new Set(), imports = new Map(), namespaces = new Set()) {
    this.#known = new Set(known)
    this.#imports = new Map(imports)
    this.#namespaces = new Set(namespaces)
    Object.freeze(this)
  }

  inputs() {
    return {
      knownBindings: new Set(this.#known),
      importBindings: new Map(this.#imports),
      importNamespaces: new Set(this.#namespaces),
    }
  }

  advance(prepared) {
    const known = new Set(this.#known)
    for (const name of prepared.declared) known.add(name)
    return new BindingCatalog(known, prepared.imports, prepared.importNamespaces)
  }
}
