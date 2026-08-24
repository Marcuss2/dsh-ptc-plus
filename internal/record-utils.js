/** Shared structural guards for closed PTC metadata boundaries. */

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function assertOwnFields(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)
      || !Object.prototype.propertyIsEnumerable.call(value, key)) {
      throw new TypeError(`invalid ${label} field ${String(key)}`)
    }
  }
}

export function assertFields(value, allowed, label) {
  if (!isRecord(value)) throw new TypeError(`invalid ${label}`)
  assertOwnFields(value, allowed, label)
  if (Reflect.ownKeys(value).length !== allowed.size) throw new TypeError(`invalid ${label} fields`)
}

export function record(value, label) {
  if (!isRecord(value)) throw new TypeError(`ptc-plus: ${label} must be an object`)
  return value
}

export function text(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`ptc-plus: ${label} must be a non-empty string`)
  }
  return value
}
