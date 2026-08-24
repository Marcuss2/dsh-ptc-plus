import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { messageOf } from './failure-reporting.js'

/** Owns one session kernel's worker process, private port, and scratch directory. */
export class WorkerClient {
  constructor({ workerUrl, cwd, maxOldGenerationSizeMb, onMessage, onFailure }) {
    this.workerUrl = workerUrl
    this.cwd = cwd
    this.maxOldGenerationSizeMb = maxOldGenerationSizeMb
    this.onMessage = onMessage
    this.onFailure = onFailure
    this.worker = undefined
    this.workerReady = undefined
    this.port = undefined
    this.scratchReady = undefined
    this.stderrTails = new WeakMap()
    this.terminations = new Set()
    this.disposed = false
  }

  /** Last non-empty stderr line of a failed worker, capped for diagnostics. */
  stderrDetail(worker) {
    const tail = this.stderrTails.get(worker)?.join('').trim()
    if (tail === undefined || tail.length === 0) return undefined
    const lastLine = tail.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0).slice(-1)[0]
    return lastLine === undefined ? undefined : lastLine.slice(0, 300)
  }

  async ensure() {
    if (this.worker !== undefined) return this.workerReady
    if (this.scratchReady === undefined) {
      const scratchRoot = tmpdir()
      if (!isAbsolute(scratchRoot)) {
        throw new Error(`ptc-plus: host temporary directory must be absolute, got ${JSON.stringify(scratchRoot)}`)
      }
      this.scratchReady = mkdtemp(join(scratchRoot, 'dsh-ptc-plus-'))
    }
    const scratchDirectory = await this.scratchReady
    /* c8 ignore next */
    if (this.disposed) throw new Error('session kernel disposed')
    /* c8 ignore next */
    if (this.worker !== undefined) return this.workerReady
    const environment = { ...process.env }
    // Test-runner instrumentation belongs to the host process, not the session worker.
    delete environment.NODE_TEST_CONTEXT
    delete environment.NODE_V8_COVERAGE
    for (const name of ['PATH', 'Path', 'ComSpec', 'COMSPEC', 'HOME', 'USERPROFILE']) {
      const value = process.env[name]
      if (value !== undefined) environment[name] = value
    }
    const worker = new Worker(this.workerUrl, {
      env: {
        ...environment,
        TEMP: scratchDirectory,
        TMP: scratchDirectory,
        TMPDIR: scratchDirectory,
      },
      execArgv: [],
      workerData: this.cwd === undefined ? {} : { cwd: this.cwd },
      resourceLimits: { maxOldGenerationSizeMb: this.maxOldGenerationSizeMb },
      stdout: true,
      stderr: true,
    })
    worker.stdout.resume()
    worker.stderr.resume()
    const stderrTail = []
    worker.stderr.on?.('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : String(chunk ?? '')
      stderrTail.push(text)
      const bounded = Buffer.from(stderrTail.join('')).subarray(-2048).toString('utf8')
      stderrTail.splice(0, stderrTail.length, bounded)
    })
    this.stderrTails.set(worker, stderrTail)
    worker.on('error', error => this.fail(worker, `worker error: ${messageOf(error)}`))
    worker.on('exit', code => this.fail(worker, `worker exited with code ${code}`))
    this.worker = worker
    this.workerReady = new Promise((resolve, reject) => {
      const onError = error => reject(error)
      const onExit = (code) => {
        const detail = this.stderrDetail(worker)
        reject(new Error(detail === undefined
          ? `worker exited with code ${code} before opening its private channel`
          : `worker exited with code ${code} before opening its private channel; last stderr: ${detail}`))
      }
      worker.once('error', onError)
      worker.once('exit', onExit)
      worker.once('message', (message) => {
        worker.removeListener('error', onError)
        worker.removeListener('exit', onExit)
        if (message?.type === 'startup-error' && typeof message.error === 'string') {
          reject(new Error(message.error))
          void this.reset(worker)
          return
        }
        if (message?.type !== 'ready' || typeof message.port?.postMessage !== 'function') {
          reject(new Error('kernel worker returned an invalid private channel'))
          void this.reset(worker)
          return
        }
        this.port = message.port
        this.port.on('message', (value) => {
          if (worker === this.worker) this.onMessage(value)
        })
        resolve(worker)
      })
    })
    return this.workerReady
  }

  post(message) {
    this.port.postMessage(message)
  }

  fail(worker, message) {
    if (worker !== this.worker) return
    this.worker = undefined
    this.workerReady = undefined
    this.port?.close()
    this.port = undefined
    const detail = this.stderrDetail(worker)
    this.onFailure(detail === undefined ? message : `${message}; last stderr: ${detail}`)
  }

  async reset(worker) {
    if (this.worker === worker) {
      this.worker = undefined
      this.workerReady = undefined
      this.port?.close()
      this.port = undefined
    }
    const termination = worker.terminate()
    this.terminations.add(termination)
    try {
      await termination
    } finally {
      this.terminations.delete(termination)
    }
  }

  async dispose() {
    this.disposed = true
    const worker = this.worker
    if (worker !== undefined) await this.reset(worker)
    await Promise.all([...this.terminations])
    if (this.scratchReady !== undefined) {
      try {
        const scratchDirectory = await this.scratchReady
        await rm(scratchDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      } catch {
        // Scratch cleanup is best-effort after all worker handles are closed.
      }
    }
  }
}
