/** Shared binding-pattern traversal used by cell analysis and REPL policy code. */

export function walkBindingPattern(pattern, visit) {
  if (pattern === null || typeof pattern !== 'object') return
  if (pattern.type === 'Identifier') {
    visit(pattern)
    return
  }
  if (pattern.type === 'RestElement') return walkBindingPattern(pattern.argument, visit)
  if (pattern.type === 'AssignmentPattern') return walkBindingPattern(pattern.left, visit)
  if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) walkBindingPattern(element, visit)
    return
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      walkBindingPattern(property.type === 'RestElement' ? property.argument : property.value, visit)
    }
  }
}

export function bindingNodes(pattern) {
  const nodes = []
  walkBindingPattern(pattern, node => nodes.push(node))
  return nodes
}

/** Allocate private identifiers outside both source and caller-owned name sets. */
export function createGeneratedNameAllocator(root, unavailableNames = []) {
  const used = new Set(unavailableNames)
  const seen = new Set()
  const pending = [root]
  while (pending.length > 0) {
    const value = pending.pop()
    if (value === null || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    if (value.type === 'Identifier') used.add(value.name)
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) pending.push(...child)
      else if (child !== null && typeof child === 'object') pending.push(child)
    }
  }
  const sequences = new Map()
  return (purpose) => {
    let sequence = sequences.get(purpose) ?? 0
    let name
    do {
      name = `__dsh_ptc_${purpose}_${sequence++}__`
    } while (used.has(name))
    sequences.set(purpose, sequence)
    used.add(name)
    return name
  }
}
