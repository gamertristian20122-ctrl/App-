#!/usr/bin/env node
// Runs the database and services suites against a real Postgres (15–17) instead of PGlite.
// Every test database is a throwaway database created on that server and dropped afterwards,
// and the cross-session tests in packages/db/test/postgres.test.ts (SKIP LOCKED, concurrent
// reservations, draft-edit vs post-insert race) run too.
//
//   TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres pnpm test:pg
//
// The URL must point at a server where the user may create databases (a CI service container or a
// local throwaway instance, never a shared or production database). Nothing is printed from it.

import { spawnSync } from 'node:child_process'

const url = process.env.TEST_PG_URL?.trim()
if (!url || !/^postgres(ql)?:\/\//.test(url)) {
  process.stderr.write('Set TEST_PG_URL to a throwaway Postgres server URL (postgres://user@host:port/postgres).\n')
  process.exit(2)
}

const env = { ...process.env, TEST_DATABASE_URL: url, APP_DB_TEST_POSTGRES_URL: url }
let failed = false
for (const pkg of ['@app/db', '@app/services']) {
  process.stdout.write(`\n== ${pkg} on Postgres ==\n`)
  const result = spawnSync('pnpm', ['-F', pkg, 'test'], { stdio: 'inherit', env })
  if (result.status !== 0) failed = true
}
process.exit(failed ? 1 : 0)
