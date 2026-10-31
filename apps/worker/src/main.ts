// Worker entrypoint (pnpm -F @app/worker start; the Docker image runs this with tsx).
// WORKER_TYPES selects the handler groups (posting, media, or all); SIGTERM/SIGINT drain gracefully.

import { createLogger } from '@app/core'
import { safeErrorMessage } from './errors'
import { shutdownGraceMs, startWorker } from './worker'

async function main(): Promise<void> {
  const worker = await startWorker(process.env)
  const log = worker.context.logger
  // never wait longer than Railway does: exit before the SIGKILL
  const hardLimitMs = shutdownGraceMs(process.env) + 8_000

  let exiting = false
  const exit = (reason: string, code: number) => {
    if (exiting) return
    exiting = true
    log.info('shutting down', { reason })
    const timer = setTimeout(() => {
      log.error('shutdown took too long; exiting')
      process.exit(code === 0 ? 1 : code)
    }, hardLimitMs)
    timer.unref()
    worker
      .stop()
      .then(() => process.exit(code))
      .catch((error: unknown) => {
        log.error('shutdown failed', { error: safeErrorMessage(error) })
        process.exit(1)
      })
  }

  process.once('SIGTERM', () => exit('SIGTERM', 0))
  process.once('SIGINT', () => exit('SIGINT', 0))
  process.on('unhandledRejection', (reason) => log.error('unhandled promise rejection', { error: safeErrorMessage(reason) }))
  process.on('uncaughtException', (error) => {
    log.error('uncaught exception', { error: safeErrorMessage(error) })
    exit('uncaughtException', 1)
  })
}

main().catch((error: unknown) => {
  // configuration errors name the variables, never their values
  createLogger({ name: 'worker' }).error('worker failed to start', { error: safeErrorMessage(error) })
  process.exit(1)
})
