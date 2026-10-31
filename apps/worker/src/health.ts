// Tiny health endpoint for Railway (healthcheckPath /health on $PORT): 200 with the runner's
// state and last claim time while the runner is running, 503 otherwise (starting, draining).
// Answers only GET/HEAD on /health, /healthz and /; carries no secrets.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { RunnerStatus } from './runner'

export interface HealthServerOptions {
  port: number
  host?: string
  status: () => RunnerStatus
}

export interface HealthServer {
  /** The bound port (useful with port 0). */
  port: number
  close(): Promise<void>
}

const PATHS = new Set(['/', '/health', '/healthz'])

export function healthBody(status: RunnerStatus): { ok: boolean; body: Record<string, unknown> } {
  const ok = status.state === 'running'
  return {
    ok,
    body: {
      ok,
      state: status.state,
      types: status.types,
      active: status.active,
      concurrency: status.concurrency,
      startedAt: status.startedAt,
      lastPollAt: status.lastPollAt,
      lastClaimAt: status.lastClaimAt,
      counts: status.counts,
    },
  }
}

export async function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    const send = (code: number, payload: unknown) => {
      const text = JSON.stringify(payload)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : text)
    }
    if (!PATHS.has(path)) return send(404, { ok: false, error: 'not_found' })
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { ok: false, error: 'method_not_allowed' })
    let result: ReturnType<typeof healthBody>
    try {
      result = healthBody(options.status())
    } catch {
      return send(503, { ok: false })
    }
    send(result.ok ? 200 : 503, result.body)
  })
  server.keepAliveTimeout = 5_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    const ready = () => {
      server.off('error', reject)
      resolve()
    }
    // no host: Node listens on every interface, IPv6 and IPv4 where available
    if (options.host) server.listen(options.port, options.host, ready)
    else server.listen(options.port, ready)
  })
  const port = (server.address() as AddressInfo).port
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }
}
