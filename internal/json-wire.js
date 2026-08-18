/** Flat lossless-JSON wire format that does not recurse with input depth. */

function invalid(path, detail) {
  throw new TypeError(`value at ${path} is not lossless JSON: ${detail}`)
}

function hasIntrinsicConstructor(prototype, name) {
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value
  if (typeof constructor !== 'function') return false
  try {
    return constructor.name === name
      && constructor.prototype === prototype
      && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`
  } catch {
    return false
  }
}

function isIntrinsicObjectPrototype(value) {
  return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, 'Object')
}

function hasPlainArrayPrototype(value) {
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, 'Array')) return false
  const objectPrototype = Object.getPrototypeOf(prototype)
  return objectPrototype !== null && typeof objectPrototype === 'object' && isIntrinsicObjectPrototype(objectPrototype)
}

function hasPlainObjectPrototype(value) {
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || (prototype !== null && typeof prototype === 'object' && isIntrinsicObjectPrototype(prototype))
}

export function encodeJson(value) {
  const wire = []
  const pending = [{ kind: 'value', value, path: '$' }]
  const ancestors = new WeakSet()

  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (item.kind === 'leave') {
      ancestors.delete(item.value)
      continue
    }
    const current = item.value
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      wire.push(current)
      continue
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) invalid(item.path, 'number must be finite and not negative zero')
      wire.push(current)
      continue
    }
    if (typeof current !== 'object') invalid(item.path, typeof current)
    if (ancestors.has(current)) invalid(item.path, 'cyclic object')
    ancestors.add(current)
    pending.push({ kind: 'leave', value: current })

    if (Array.isArray(current)) {
      if (!hasPlainArrayPrototype(current)) invalid(item.path, 'non-plain array')
      if (Reflect.ownKeys(current).length !== current.length + 1) invalid(item.path, 'array has non-index properties')
      wire.push({ kind: 'array', length: current.length })
      for (let index = current.length - 1; index >= 0; index -= 1) {
        if (!Object.hasOwn(current, index)) invalid(`${item.path}[${index}]`, 'sparse array slot')
        pending.push({ kind: 'value', value: current[index], path: `${item.path}[${index}]` })
      }
      continue
    }

    if (!hasPlainObjectPrototype(current)) invalid(item.path, 'non-plain object')
    const ownKeys = Reflect.ownKeys(current)
    if (ownKeys.some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(current, key))) {
      invalid(item.path, 'object has non-enumerable or symbol properties')
    }
    const keys = ownKeys
    wire.push({ kind: 'object', keys })
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]
      pending.push({ kind: 'value', value: current[key], path: `${item.path}.${key}` })
    }
  }
  return wire
}

export function decodeJson(wire) {
  if (!Array.isArray(wire) || wire.length === 0) throw new TypeError('invalid empty JSON wire value')
  const frames = []
  let root

  const attach = (value) => {
    const parent = frames.at(-1)
    if (parent === undefined) {
      if (root !== undefined) throw new TypeError('invalid JSON wire with multiple roots')
      root = value
      return
    }
    if (parent.kind === 'array') parent.target[parent.index] = value
    else {
      Object.defineProperty(parent.target, parent.keys[parent.index], {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    parent.index += 1
  }

  for (const token of wire) {
    let value = token
    let frame
    if (token !== null && typeof token === 'object') {
      if (token.kind === 'array' && Number.isSafeInteger(token.length) && token.length >= 0) {
        value = []
        frame = { kind: 'array', target: value, length: token.length, index: 0 }
      } else if (token.kind === 'object' && Array.isArray(token.keys) && token.keys.every(key => typeof key === 'string')) {
        value = {}
        frame = { kind: 'object', target: value, keys: token.keys, index: 0 }
      } else {
        throw new TypeError('invalid JSON wire container')
      }
    } else if (!(token === null || typeof token === 'string' || typeof token === 'boolean' || (typeof token === 'number' && Number.isFinite(token)))) {
      throw new TypeError('invalid JSON wire primitive')
    }

    attach(value)
    const size = frame?.kind === 'array' ? frame.length : frame?.keys.length
    if (frame !== undefined && size > 0) frames.push(frame)
    while (frames.length > 0) {
      const current = frames.at(-1)
      const currentSize = current.kind === 'array' ? current.length : current.keys.length
      if (current.index < currentSize) break
      frames.pop()
    }
  }

  if (frames.length !== 0) throw new TypeError('truncated JSON wire value')
  return root
}
