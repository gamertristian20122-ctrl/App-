// A throwaway Postgres 16 cluster for the run: initdb into a fresh data directory, trust auth on
// 127.0.0.1 only, started with pg_ctl. Postgres refuses to run as root, so as root every command
// runs as the "postgres" OS user (runuser -u postgres); as any other user it runs directly.

import { chownSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { onStop, run } from './procs'
import { log } from './util'

export interface PostgresOptions {
  /** Directory for the cluster (wiped first). */
  dir: string
  port: number
  /** Directory with initdb / pg_ctl / postgres. */
  binDir: string
}

export interface PostgresHandle {
  /** postgres://postgres@127.0.0.1:<port>/<db> */
  url(db: string): string
  createDatabase(db: string): Promise<void>
  stop(): Promise<void>
}

const PG_BIN_CANDIDATES = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/15/bin']

export function findPgBin(explicit?: string): string {
  const candidates = explicit ? [explicit] : PG_BIN_CANDIDATES
  for (const dir of candidates) if (existsSync(join(dir, 'pg_ctl'))) return dir
  throw new Error(`Postgres binaries not found (looked in ${candidates.join(', ')}); set E2E_PG_BIN`)
}

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0

/** Runs a Postgres binary as the postgres user when we are root. */
function pg(binDir: string, tool: string, args: string[], logFile?: string) {
  const exe = join(binDir, tool)
  return asRoot
    ? run('runuser', ['-u', 'postgres', '--', exe, ...args], logFile ? { logFile } : {})
    : run(exe, args, logFile ? { logFile } : {})
}

export async function startPostgres(options: PostgresOptions): Promise<PostgresHandle> {
  const { dir, port, binDir } = options
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  if (asRoot) {
    const ids = await run('id', ['-u', 'postgres']).then((r) => Number(r.stdout.trim()))
    const gid = await run('id', ['-g', 'postgres']).then((r) => Number(r.stdout.trim()))
    chownSync(dir, ids, gid)
  }
  const data = join(dir, 'data')
  const logFile = join(dir, 'server.log')
  await pg(binDir, 'initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--no-sync', '--locale=C'], join(dir, 'initdb.log'))
  // Unix socket in the run dir (not /var/run/postgresql), TCP on loopback only, fsync off (throwaway).
  const serverOpts = `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`
  await pg(binDir, 'pg_ctl', ['-D', data, '-o', serverOpts, '-l', logFile, '-w', '-t', '60', 'start'])
  log(`postgres listening on 127.0.0.1:${port} (data ${data})`)

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await pg(binDir, 'pg_ctl', ['-D', data, '-m', 'fast', '-w', '-t', '30', 'stop']).catch(() => undefined)
  }
  onStop('postgres', stop)

  return {
    url: (db) => `postgres://postgres@127.0.0.1:${port}/${db}`,
    async createDatabase(db) {
      await pg(binDir, 'psql', ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `create database "${db}"`])
    },
    stop,
  }
}
