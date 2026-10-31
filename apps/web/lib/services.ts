// The web app's single services instance (server-only). Built once per process from the
// environment and cached on globalThis so Next.js dev reloads do not open new pools.
// Local dev: DATABASE_URL="pglite:<dir>" (or "pglite:memory") uses an in-process PGlite database;
// without DATABASE_URL, PGLITE_DATA_DIR is used. Production requires a Postgres DATABASE_URL.

import { createServicesFromEnv, type Services, type ServicesFromEnv, type ServicesFromEnvOptions } from '@app/services'

const CACHE_KEY = Symbol.for('app.web.services')

interface Holder {
  promise: Promise<ServicesFromEnv> | null
}

function holder(): Holder {
  const g = globalThis as typeof globalThis & { [CACHE_KEY]?: Holder }
  g[CACHE_KEY] ??= { promise: null }
  return g[CACHE_KEY]
}

/**
 * Everything built from the environment: services, config, db, provider, storage (the same
 * storage instance the dev-storage route must serve), clock and logger. The web app does not
 * transcribe, so no transcriber is built.
 */
export function getServicesRuntime(): Promise<ServicesFromEnv> {
  const h = holder()
  if (!h.promise) {
    h.promise = createServicesFromEnv(process.env, { withoutTranscriber: true }).catch((error: unknown) => {
      // let the next request retry (e.g. the database was briefly unreachable)
      h.promise = null
      throw error
    })
  }
  return h.promise
}

/** The services (every business rule). */
export async function getServices(): Promise<Services> {
  return (await getServicesRuntime()).services
}

/**
 * Tests: install a prebuilt runtime (or build one from a custom env/options), or reset with null.
 * Never used by application code.
 */
export async function setServicesRuntimeForTests(
  runtime: ServicesFromEnv | null | { env: Record<string, string | undefined>; options?: ServicesFromEnvOptions },
): Promise<ServicesFromEnv | null> {
  const h = holder()
  if (runtime === null) {
    h.promise = null
    return null
  }
  if ('services' in runtime) {
    h.promise = Promise.resolve(runtime)
    return runtime
  }
  const built = await createServicesFromEnv(runtime.env, { withoutTranscriber: true, ...runtime.options })
  h.promise = Promise.resolve(built)
  return built
}
