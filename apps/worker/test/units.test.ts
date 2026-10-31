// Pure units: handler registry, failure classification, health endpoint, shutdown grace.

import { describe, expect, it } from 'vitest'
import { AppError } from '@app/core'
import { memoryLogger } from '@app/core/testing'
import { providerError } from '@app/posting'
import { PermanentJobError, RetryJobError, classifyFailure, retryDelayMs, safeErrorMessage } from '../src/errors'
import { healthBody, startHealthServer } from '../src/health'
import { mediaHandlers } from '../src/media'
import { postingHandlers } from '../src/posting'
import { buildRegistry } from '../src/registry'
import type { RunnerStatus } from '../src/runner'
import type { Handler } from '../src/types'
import { shutdownGraceMs } from '../src/worker'

const noop: Handler = async () => null

describe('buildRegistry', () => {
  const sets = { posting: postingHandlers, media: { transcribe: noop, clip_render: noop } }

  it('selects handlers by worker group', () => {
    expect(buildRegistry(['posting'], sets).types.sort()).toEqual(['analytics_pull', 'check_post_status', 'cleanup', 'import_past_posts', 'publish_post'])
    const media = buildRegistry(['media'], sets)
    expect(media.types.sort()).toEqual(['clip_render', 'transcribe'])
    expect(media.missing.sort()).toEqual(['carousel_render', 'source_ingest', 'video_render'])
    expect(buildRegistry(['posting', 'media'], sets).types).toHaveLength(7)
  })

  it('ignores handlers registered under the wrong group or an unknown type', () => {
    const log = memoryLogger()
    const reg = buildRegistry(['posting', 'media'], { posting: { ...postingHandlers, transcribe: noop }, media: { publish_post: noop, bogus: noop } }, log)
    expect(reg.handlers.publish_post).toBe(postingHandlers.publish_post)
    expect(reg.handlers.transcribe).toBeUndefined()
    expect(log.lines.filter((l) => l.msg === 'ignoring a handler outside its worker group')).toHaveLength(3)
  })

  it('merges the media group from ./media (owned by the media worker)', () => {
    const reg = buildRegistry(['media'], { posting: postingHandlers, media: mediaHandlers })
    for (const type of reg.types) expect(typeof reg.handlers[type]).toBe('function')
  })
})

describe('classifyFailure', () => {
  it('treats invalid input and missing records as permanent', () => {
    expect(classifyFailure(new PermanentJobError('x'), 1).permanent).toBe(true)
    expect(classifyFailure(new AppError('validation', 'bad'), 1).permanent).toBe(true)
    expect(classifyFailure(new AppError('not_found', 'gone'), 1).permanent).toBe(true)
    expect(classifyFailure(providerError('provider_rejected', 'no', { provider: 'fake' }), 1).permanent).toBe(true)
  })

  it('retries everything else with backoff, a provider hint or an explicit delay', () => {
    const policy = { baseMs: 1_000, maxMs: 60_000, jitter: 0 }
    expect(classifyFailure(new Error('boom'), 3, policy)).toMatchObject({ permanent: false, retryInMs: 4_000 })
    expect(classifyFailure(new AppError('unavailable', 'down'), 10, policy).retryInMs).toBe(60_000)
    expect(classifyFailure(providerError('rate_limited', 'slow', { provider: 'fake', retryAfterSec: 7 }), 1, policy).retryInMs).toBe(7_000)
    expect(classifyFailure(new RetryJobError('later', 1234), 1, policy).retryInMs).toBe(1_234)
  })

  it('jitters within bounds and scrubs messages', () => {
    for (let i = 0; i < 20; i++) {
      const d = retryDelayMs(2, { baseMs: 1_000, maxMs: 60_000, jitter: 0.5 })
      expect(d).toBeGreaterThanOrEqual(1_000)
      expect(d).toBeLessThanOrEqual(2_000)
    }
    expect(safeErrorMessage(new Error('failed: Authorization: Bearer sk_live_abcdefghijklmnop'))).not.toContain('sk_live_abcdefghijklmnop')
    expect(safeErrorMessage(null)).toBe('Job failed.')
  })
})

describe('health endpoint', () => {
  const status = (state: RunnerStatus['state']): RunnerStatus => ({
    state,
    workerId: 'w',
    types: ['publish_post'],
    concurrency: 2,
    active: 1,
    startedAt: '2026-11-02T12:00:00.000Z',
    lastPollAt: '2026-11-02T12:00:05.000Z',
    lastClaimAt: '2026-11-02T12:00:01.000Z',
    counts: { succeeded: 1, failed: 0, dead: 0, released: 0, lost: 0 },
  })

  it('answers ok with the last claim time while running, 503 otherwise', async () => {
    let state: RunnerStatus['state'] = 'running'
    const server = await startHealthServer({ port: 0, host: '127.0.0.1', status: () => status(state) })
    try {
      const base = `http://127.0.0.1:${server.port}`
      let res = await fetch(`${base}/health`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body).toMatchObject({ ok: true, state: 'running', lastClaimAt: '2026-11-02T12:00:01.000Z' })
      expect(body).not.toHaveProperty('workerId')
      state = 'stopping'
      res = await fetch(`${base}/healthz`)
      expect(res.status).toBe(503)
      expect(((await res.json()) as { ok: boolean }).ok).toBe(false)
      expect((await fetch(`${base}/nope`)).status).toBe(404)
      expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(405)
    } finally {
      await server.close()
    }
  })

  it('health body is ok only while running', () => {
    expect(healthBody(status('running')).ok).toBe(true)
    expect(healthBody(status('idle')).ok).toBe(false)
    expect(healthBody(status('stopped')).ok).toBe(false)
  })
})

describe('shutdownGraceMs', () => {
  it('follows Railway’s draining window, with a safe default', () => {
    expect(shutdownGraceMs({})).toBe(25_000)
    expect(shutdownGraceMs({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '120' })).toBe(110_000)
    expect(shutdownGraceMs({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '3' })).toBe(1_000)
    expect(shutdownGraceMs({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '-1' })).toBe(25_000)
    expect(shutdownGraceMs({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: 'lots' })).toBe(25_000)
  })
})
