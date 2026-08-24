import { record } from './record-utils.js'

const SOFT_PLUGIN_NAMESPACES = new Set(['capabilities', 'code', 'repl'])

function name(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`ptc-plus: ${label} must be a non-empty string`)
  }
  return value
}

function normalizeErrorClass(value, globalName) {
  if (value === undefined) return undefined
  const descriptor = record(value, `binding ${globalName} errorClass`)
  return Object.freeze({
    name: name(descriptor.name, `binding ${globalName} errorClass.name`),
    memberNameProperty: name(
      descriptor.memberNameProperty,
      `binding ${globalName} errorClass.memberNameProperty`,
    ),
  })
}

export function normalizeBindingDescriptors(bindings) {
  if (!Array.isArray(bindings)) throw new TypeError('ptc-plus: bindings must be an array')
  const reservedNames = new Set()
  const namespaceNames = new Set()
  const namespaces = bindings.map((value) => {
    const namespace = record(value, 'binding namespace')
    const globalName = name(namespace.global, 'binding namespace global')
    if (namespaceNames.has(globalName)) {
      throw new TypeError(`ptc-plus: duplicate binding namespace global ${JSON.stringify(globalName)}`)
    }
    namespaceNames.add(globalName)
    const functions = record(namespace.functions, `binding ${globalName} functions`)
    const members = Reflect.ownKeys(functions).map((member) => {
      if (typeof member !== 'string' || member.length === 0) {
        throw new TypeError(`ptc-plus: binding ${globalName} member names must be non-empty strings`)
      }
      const descriptor = Object.getOwnPropertyDescriptor(functions, member)
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
        throw new TypeError(`ptc-plus: binding ${globalName}.${member} is not an own callable value`)
      }
      return member
    })
    const errorClass = normalizeErrorClass(namespace.errorClass, globalName)
    if (!SOFT_PLUGIN_NAMESPACES.has(globalName)) reservedNames.add(globalName)
    if (errorClass !== undefined) reservedNames.add(errorClass.name)
    return Object.freeze({
      global: globalName,
      functions,
      members: Object.freeze(members),
      ...(errorClass === undefined ? {} : { errorClass }),
    })
  })
  return Object.freeze({
    namespaces: Object.freeze(namespaces),
    reservedNames,
    workerDescriptors: Object.freeze(namespaces.map(namespace => Object.freeze({
      global: namespace.global,
      members: namespace.members,
      ...(namespace.errorClass === undefined ? {} : { errorClass: namespace.errorClass }),
    }))),
  })
}
