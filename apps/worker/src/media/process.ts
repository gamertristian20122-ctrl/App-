// Child processes for the media tools (ffmpeg, ffprobe). Always spawned with an argument array
// (never through a shell, so nothing a user typed can become a command), with a minimal
// environment (no database URL or API keys), killed on abort or timeout, and with a bounded
// stderr tail kept for diagnostics (callers scrub it before logging; it never reaches users).

import { spawn } from 'node:child_process'
import { JobAbortedError } from '../errors'

export type ToolFailure = 'spawn' | 'exit' | 'timeout' | 'output_too_large'

/** A media tool failed. `message` is safe to store; `stderrTail` may hold paths/URLs (scrub before logging). */
export class MediaToolError extends Error {
  override readonly name = 'MediaToolError'
  constructor(
    message: string,
    readonly reason: ToolFailure,
    readonly tool: string,
    readonly exitCode: number | null,
    readonly stderrTail: string,
  ) {
    super(message)
  }
}

export interface RunToolOptions {
  /** Working directory (relative file names in filter graphs resolve here). */
  cwd?: string
  signal?: AbortSignal | undefined
  /** Hard limit for the whole run. */
  timeoutMs: number
  /** Keep stdout (ffprobe JSON). Default false (ignored). */
  captureStdout?: boolean
  /** Largest stdout kept before the process is killed. Default 8 MB. */
  maxStdoutBytes?: number
}

export interface RunToolResult {
  stdout: string
  stderrTail: string
}

const STDERR_TAIL_BYTES = 16 * 1024
const ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_DIRS']

/** The environment a media tool sees: only what it needs (no secrets from the worker's env). */
export function toolEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ENV_KEYS) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function toolName(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command
  return base.slice(0, 40) || 'tool'
}

/**
 * Runs `command args...` and resolves with its stdout (when captured) once it exits 0.
 * Rejects with JobAbortedError when `signal` aborts, MediaToolError otherwise.
 */
export function runTool(command: string, args: readonly string[], options: RunToolOptions): Promise<RunToolResult> {
  const tool = toolName(command)
  const { signal } = options
  if (signal?.aborted) return Promise.reject(new JobAbortedError())
  const maxStdout = options.maxStdoutBytes ?? 8 * 1024 * 1024

  return new Promise<RunToolResult>((resolve, reject) => {
    let settled = false
    let killedFor: 'abort' | 'timeout' | 'stdout' | null = null
    const stdoutChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrTail = ''

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: toolEnv(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', options.captureStdout ? 'pipe' : 'ignore', 'pipe'],
    })

    const kill = (why: 'abort' | 'timeout' | 'stdout') => {
      if (killedFor) return
      killedFor = why
      child.kill('SIGKILL')
    }
    const onAbort = () => kill('abort')
    const timer = setTimeout(() => kill('timeout'), Math.max(1, options.timeoutMs))
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (error: Error | null, result?: RunToolResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(result as RunToolResult)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > maxStdout) {
        kill('stdout')
        return
      }
      stdoutChunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      const missing = error.code === 'ENOENT'
      finish(
        new MediaToolError(
          missing ? `${tool} is not installed on this worker.` : `${tool} could not be started.`,
          'spawn',
          tool,
          null,
          '',
        ),
      )
    })
    child.on('close', (code) => {
      if (killedFor === 'abort') return finish(new JobAbortedError())
      if (killedFor === 'timeout') return finish(new MediaToolError(`${tool} took too long.`, 'timeout', tool, code, stderrTail))
      if (killedFor === 'stdout') return finish(new MediaToolError(`${tool} produced too much output.`, 'output_too_large', tool, code, stderrTail))
      if (code !== 0) return finish(new MediaToolError(`${tool} failed (exit code ${code ?? 'signal'}).`, 'exit', tool, code, stderrTail))
      finish(null, { stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderrTail })
    })
  })
}

/** Global ffmpeg flags: quiet, never interactive, overwrite outputs. */
export const FFMPEG_BASE_ARGS = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', '-y'] as const

/** A running media tool that reads its input from stdin (frames piped into ffmpeg). */
export interface StreamingTool {
  /** Writes one chunk, waiting while the pipe is full. Rejects once the tool has stopped. */
  write(chunk: Uint8Array): Promise<void>
  /** Closes stdin and resolves when the tool exits 0 (rejects like runTool otherwise). */
  finish(): Promise<RunToolResult>
  /** Kills the tool (no-op once it exited). */
  kill(): void
}

/**
 * Like runTool, but with stdin open for streaming input (`-i pipe:0`). Same guarantees: argument
 * array, no shell, minimal environment, killed on abort or timeout, bounded stderr tail.
 */
export function startTool(command: string, args: readonly string[], options: RunToolOptions): StreamingTool {
  const tool = toolName(command)
  const { signal } = options
  let killedFor: 'abort' | 'timeout' | null = null
  let stderrTail = ''
  let exit: { error: Error | null } | null = null
  const child = spawn(command, [...args], { cwd: options.cwd, env: toolEnv(), shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
  const kill = (why: 'abort' | 'timeout') => {
    if (killedFor || exit) return
    killedFor = why
    child.kill('SIGKILL')
  }
  const onAbort = () => kill('abort')
  const timer = setTimeout(() => kill('timeout'), Math.max(1, options.timeoutMs))
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) kill('abort')

  const done = new Promise<RunToolResult>((resolve, reject) => {
    const settle = (error: Error | null) => {
      if (exit) return
      exit = { error }
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve({ stdout: '', stderrTail })
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      settle(new MediaToolError(error.code === 'ENOENT' ? `${tool} is not installed on this worker.` : `${tool} could not be started.`, 'spawn', tool, null, ''))
    })
    child.on('close', (code) => {
      if (killedFor === 'abort') return settle(new JobAbortedError())
      if (killedFor === 'timeout') return settle(new MediaToolError(`${tool} took too long.`, 'timeout', tool, code, stderrTail))
      if (code !== 0) return settle(new MediaToolError(`${tool} failed (exit code ${code ?? 'signal'}).`, 'exit', tool, code, stderrTail))
      settle(null)
    })
  })
  // a broken pipe surfaces through `done` (the exit code); swallow the stream error itself
  child.stdin?.on('error', () => undefined)
  done.catch(() => undefined)

  return {
    async write(chunk) {
      if (exit || !child.stdin || child.stdin.destroyed) {
        await done
        throw new MediaToolError(`${tool} stopped reading its input.`, 'exit', tool, null, stderrTail)
      }
      if (child.stdin.write(chunk)) return
      await new Promise<void>((resolve) => {
        const stdin = child.stdin
        const finish = () => {
          stdin?.off('drain', finish)
          stdin?.off('close', finish)
          resolve()
        }
        stdin?.once('drain', finish)
        stdin?.once('close', finish)
      })
    },
    async finish() {
      child.stdin?.end()
      return done
    },
    kill() {
      kill('abort')
    },
  }
}
