// Test helpers for every package: deterministic clocks, key rings, captured logs and config.
// Import from "@app/core/testing" in tests only.

import { createKeyRing, type KeyRing } from './crypto'
import { loadConfig, type Config } from './config'
import { createLogger, type LogLevel, type Logger } from './log'
import { fixedClock, manualClock } from './time'

export { fixedClock, manualClock }

/** A fixed, obviously fake 32-byte key ring for tests ("vtest"). Never use outside tests. */
export const TEST_TOKEN_ENCRYPTION_KEYS = `vtest:${Buffer.alloc(32, 7).toString('base64')}`

export function testKeyRing(): KeyRing {
  return createKeyRing([{ version: 'vtest', key: Buffer.alloc(32, 7) }])
}

export const TEST_SESSION_SECRET = 'test-session-secret-0123456789abcdef'

/** A valid config for tests: fakes everywhere, in-memory storage, DEV_AUTH on. */
export function testConfig(overrides: Record<string, string | undefined> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    APP_ENV: 'test',
    APP_URL: 'http://localhost:3000',
    LOG_LEVEL: 'error',
    PGLITE_DATA_DIR: 'memory',
    DEV_AUTH: '1',
    SESSION_SECRET: TEST_SESSION_SECRET,
    TOKEN_ENCRYPTION_KEYS: TEST_TOKEN_ENCRYPTION_KEYS,
    POSTING_PROVIDER: 'fake',
    STORAGE_DRIVER: 'memory',
    TRANSCRIPTION_PROVIDER: 'fake',
    ...overrides,
  })
}

export interface CapturedLine {
  level: LogLevel
  msg: string
  [key: string]: unknown
}

export type MemoryLogger = Omit<Logger, 'child'> & { lines: CapturedLine[]; text(): string; child(bindings: Record<string, unknown>): MemoryLogger }

/** A logger that records parsed lines in memory (for asserting redaction or messages). Children share the buffer. */
export function memoryLogger(level: LogLevel = 'debug'): MemoryLogger {
  const lines: CapturedLine[] = []
  const raw: string[] = []
  const wrap = (logger: Logger): MemoryLogger =>
    Object.assign(Object.create(logger) as Logger, {
      lines,
      text: () => raw.join('\n'),
      child: (bindings: Record<string, unknown>) => wrap(logger.child(bindings)),
    }) as MemoryLogger
  return wrap(
    createLogger({
      level,
      name: 'test',
      sink: (line) => {
        raw.push(line)
        lines.push(JSON.parse(line) as CapturedLine)
      },
    }),
  )
}
