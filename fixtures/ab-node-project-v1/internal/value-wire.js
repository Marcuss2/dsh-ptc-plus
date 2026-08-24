export function projectValueWire(value) {
  if (value === null || value === undefined) {
    return { complete: true, value }
  }

  if (typeof value === 'string') {
    return { complete: true, value }
  }

  if (Array.isArray(value)) {
    return {
      complete: false,
      value: value.slice(0, 3),
      truncated: value.length > 3,
    }
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value)
    return {
      complete: false,
      value: Object.fromEntries(keys.slice(0, 3).map(key => [key, value[key]])),
      truncated: keys.length > 3,
    }
  }

  return { complete: true, value }
}
