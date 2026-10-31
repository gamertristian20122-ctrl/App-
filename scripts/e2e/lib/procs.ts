// Child processes for the run (Postgres control, next build/start, the worker, ffmpeg). Long-lived
// processes are registered so stopAll() can shut them down on success, failure or Ctrl-C.

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { log, sleep } from './util'

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Runs a command to completion. Throws on a non-zero exit unless allowFailure. */
export function run(
  cmd: string,
  args: readonly string[],
  options: SpawnOptions & { allowFailure?: boolean; logFile?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  const { allowFailure, logFile, timeoutMs, ...spawnOptions } = options
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const file = logFile ? createWriteStream(logFile, { flags: 'a' }) : null
    child.stdout?.on('data', (d: Buffer) => {
      out.push(d)
      file?.write(d)
    })
    child.stderr?.on('data', (d: Buffer) => {
      err.push(d)
      file?.write(d)
    })
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null
    child.on('error', (e) => {
      if (timer) clearTimeout(timer)
      file?.end()
      reject(e)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      file?.end()
      const result = { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }
      if (code !== 0 && !allowFailure) {
        const tail = (result.stderr || result.stdout).trim().split('\n').slice(-15).join('\n')
        reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}${logFile ? ` (log: ${logFile})` : ''}\n${tail}`))
      } else resolve(result)
    })
  })
}

export interface Service {
  name: string
  child: ChildProcess
  logFile: string
  /** Resolves when the process has exited. */
  exited: Promise<number | null>
}

const services: Service[] = []
const stoppers: Array<{ name: string; stop: () => Promise<void> }> = []

/** Starts a long-running process with stdout/stderr appended to logFile. */
export function startService(name: string, cmd: string, args: readonly string[], options: SpawnOptions & { logFile: string }): Service {
  const { logFile, ...spawnOptions } = options
  const file = createWriteStream(logFile, { flags: 'a' })
  // detached: its own process group, so the whole tree (pnpm/next/tsx children) can be signalled
  const child = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...spawnOptions })
  child.stdout?.pipe(file)
  child.stderr?.pipe(file)
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  const service = { name, child, logFile, exited }
  services.push(service)
  return service
}

/** Registers extra cleanup (Postgres, HTTP stubs, the browser). Runs in reverse order. */
export function onStop(name: string, stop: () => Promise<void>): void {
  stoppers.push({ name, stop })
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

/** Stops every registered service (SIGTERM, then SIGKILL after 15 s) and runs the stoppers. */
export async function stopAll(): Promise<void> {
  for (const s of [...services].reverse()) {
    if (s.child.exitCode !== null || s.child.signalCode !== null) continue
    log(`stopping ${s.name}`)
    signalGroup(s.child, 'SIGTERM')
    const done = await Promise.race([s.exited.then(() => true), sleep(15_000).then(() => false)])
    if (!done) {
      log(`${s.name} did not stop in time; killing it`)
      signalGroup(s.child, 'SIGKILL')
      await Promise.race([s.exited, sleep(3_000)])
    }
  }
  services.length = 0
  for (const s of [...stoppers].reverse()) {
    try {
      log(`stopping ${s.name}`)
      await s.stop()
    } catch (error) {
      log(`stopping ${s.name} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  stoppers.length = 0
}

/** Fails fast when a service died while we wait for something else. */
export function assertServicesAlive(): void {
  for (const s of services) {
    if (s.child.exitCode !== null) throw new Error(`${s.name} exited with code ${s.child.exitCode} (log: ${s.logFile})`)
  }
}
