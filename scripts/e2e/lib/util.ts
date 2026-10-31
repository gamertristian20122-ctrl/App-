// Small helpers for the end-to-end run: logging, assertions, polling, free ports, paths.

import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root (scripts/e2e/lib → ../../..). */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const started = Date.now()
const stamp = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s`

export function log(message: string): void {
  process.stdout.write(`[e2e ${stamp()}] ${message}\n`)
}

export class AssertionError extends Error {
  override name = 'AssertionError'
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(message)
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new AssertionError(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

export function assertMatch(text: string, pattern: RegExp, message: string): void {
  if (!pattern.test(text)) throw new AssertionError(`${message}: ${pattern} did not match ${JSON.stringify(text.slice(0, 600))}`)
}

/** Every check that passed, in order (printed in the summary). */
export const passed: string[] = []

/** Runs one named check; logs and records it. Failures propagate (the run stops). */
export async function check<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const t0 = Date.now()
  log(`▶ ${name}`)
  try {
    const out = await fn()
    passed.push(name)
    log(`✔ ${name} (${Date.now() - t0} ms)`)
    return out
  } catch (error) {
    log(`✘ ${name}: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

/** Polls `fn` until it returns a non-undefined value (or throws after timeoutMs). */
export async function waitFor<T>(what: string, fn: () => Promise<T | undefined> | T | undefined, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const intervalMs = options.intervalMs ?? 1_000
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  for (;;) {
    try {
      const value = await fn()
      if (value !== undefined) return value
    } catch (error) {
      if (error instanceof AssertionError) throw error
      lastError = error
    }
    if (Date.now() > deadline) {
      const detail = lastError instanceof Error ? ` (last error: ${lastError.message})` : ''
      throw new AssertionError(`Timed out after ${timeoutMs} ms waiting for ${what}${detail}`)
    }
    await sleep(intervalMs)
  }
}

/** A TCP port that is free on 127.0.0.1 right now. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 0
      srv.close(() => resolvePort(port))
    })
  })
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
