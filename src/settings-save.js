function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Persist changed settings and prove each write against the authoritative snapshot. */
export async function saveSettings(preferenceScope, before, draft, fields) {
  const changed = fields.filter(field => !valuesEqual(draft[field.key], before.value?.[field.key]))
  const persisted = []
  let revision = before.revision
  for (const field of changed) {
    await preferenceScope.set(field.key, draft[field.key])
    const after = preferenceScope.getSnapshot()
    const landed = after.status === 'ready'
      && after.revision !== revision
      && valuesEqual(after.value?.[field.key], draft[field.key])
    if (!landed) {
      return Object.freeze({ ok: false, persisted: Object.freeze(persisted), failed: field.key })
    }
    persisted.push(field.key)
    revision = after.revision
  }
  return Object.freeze({ ok: true, persisted: Object.freeze(persisted) })
}
