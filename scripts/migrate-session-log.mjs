import { execFileSync } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrateRecoveryBoundaryEvents, RECOVERY_BOUNDARY_EVENT } from '../internal/session-journal.js'

function parseJsonLines(text) {
  if (typeof text !== 'string') throw new TypeError('session log text must be a string')
  return text.split(/\r?\n/).filter(line => line.trim() !== '').map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`invalid session JSONL at line ${index + 1}: ${error.message}`)
    }
  })
}

function serializeJsonLines(events) {
  if (!Array.isArray(events)) throw new TypeError('session log events must be an array')
  return events.length === 0 ? '' : `${events.map(event => JSON.stringify(event)).join('\n')}\n`
}

/** Migrate one decoded session artifact without mutating its parsed events. */
export function migrateSessionLogText(text) {
  const [header, ...events] = parseJsonLines(text)
  if (header?.type !== 'session') throw new Error('session JSONL does not start with a session header')
  const legacyCount = events.filter(event => event?.type === RECOVERY_BOUNDARY_EVENT).length
  if (legacyCount === 0) {
    return Object.freeze({ changed: false, legacyCount: 0, text })
  }
  const migrated = migrateRecoveryBoundaryEvents(events)
  return Object.freeze({
    changed: true,
    legacyCount,
    text: serializeJsonLines([header, ...migrated]),
  })
}

function isCompressed(file) {
  return file.endsWith('.zstd')
}

function decodeArtifact(file, options = {}) {
  if (!isCompressed(file)) return readFile(file, 'utf8')
  const run = options.execFileSync ?? execFileSync
  return Promise.resolve(run('zstd', ['-q', '-d', '-c', file], {
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 512 * 1024 * 1024,
  }))
}

function encodeArtifact(file, text, options = {}) {
  if (!isCompressed(file)) return writeFile(file, text, 'utf8')
  const run = options.execFileSync ?? execFileSync
  const headerEnd = text.indexOf('\n')
  if (headerEnd < 0) throw new Error('session log does not contain a header line')
  const encodeFrame = input => run('zstd', ['-q', '-T0', '--check', '-c'], {
    input,
    maxBuffer: options.maxBuffer ?? 512 * 1024 * 1024,
  })
  const headerFrame = encodeFrame(text.slice(0, headerEnd + 1))
  const eventFrame = encodeFrame(text.slice(headerEnd + 1))
  return writeFile(file, Buffer.concat([headerFrame, eventFrame]))
}

/**
 * Migrate a file into a separate output path. Existing files are never replaced
 * unless `overwrite` is explicitly true; the input artifact is never changed.
 */
export async function migrateSessionLogFile(input, output, options = {}) {
  const inputPath = resolve(input)
  const outputPath = resolve(output)
  if (inputPath === outputPath) throw new Error('migration output must differ from input')
  const source = await decodeArtifact(inputPath, options)
  const result = migrateSessionLogText(source)
  if (!result.changed) return Object.freeze({ ...result, input: inputPath, output: outputPath, written: false })
  if (!options.overwrite) {
    try {
      await stat(outputPath)
      throw new Error(`migration output already exists: ${outputPath}`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  await encodeArtifact(outputPath, result.text, options)
  return Object.freeze({ ...result, input: inputPath, output: outputPath, written: true })
}

function usage() {
  return 'Usage: node scripts/migrate-session-log.mjs --input PATH --output PATH [--force]'
}

function parseArgs(argv) {
  const values = { force: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--force') {
      values.force = true
      continue
    }
    if (arg === '--input' || arg === '--output') {
      const value = argv[++index]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a path`)
      values[arg.slice(2)] = value
      continue
    }
    throw new Error(`unknown argument ${arg}`)
  }
  if (values.input === undefined || values.output === undefined) throw new Error(usage())
  return values
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const result = await migrateSessionLogFile(args.input, args.output, { overwrite: args.force })
  if (!result.changed) {
    console.log(`no ${RECOVERY_BOUNDARY_EVENT} events found; no output written`)
    return result
  }
  console.log(`migrated ${result.legacyCount} legacy recovery boundary event(s) to ${result.output}`)
  return result
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack ?? error.message ?? String(error))
    process.exitCode = 1
  })
}
