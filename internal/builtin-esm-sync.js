import { syncBuiltinESMExports } from 'node:module'

export function synchronizeBuiltinEsmExports(sync = syncBuiltinESMExports) {
  try {
    sync()
  } catch (cause) {
    throw new Error('ptc-plus: failed to synchronize patched Node filesystem exports', { cause })
  }
}
