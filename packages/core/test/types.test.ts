import { describe, expect, it } from 'vitest'
import {
  ACTIVE_POST_STATUSES,
  JOB_GROUP,
  JOB_TYPES,
  METRIC_KEYS,
  MetricsSchema,
  PLATFORMS,
  PLATFORM_LABELS,
  PlatformSchema,
  isPlatform,
  pickMetrics,
} from '../src/types'

describe('types', () => {
  it('lists the nine platforms in schema order', () => {
    expect(PLATFORMS).toEqual(['tiktok', 'youtube', 'instagram', 'facebook', 'threads', 'x', 'linkedin', 'pinterest', 'bluesky'])
    for (const p of PLATFORMS) expect(PLATFORM_LABELS[p]).toBeTruthy()
  })

  it('guards platforms', () => {
    expect(isPlatform('x')).toBe(true)
    expect(isPlatform('twitter')).toBe(false)
    expect(isPlatform(3)).toBe(false)
    expect(PlatformSchema.safeParse('reddit').success).toBe(false)
  })

  it('assigns every job type to a worker group', () => {
    for (const t of JOB_TYPES) expect(['posting', 'media']).toContain(JOB_GROUP[t])
    expect(JOB_GROUP.clip_render).toBe('media')
    expect(JOB_GROUP.publish_post).toBe('posting')
  })

  it('counts scheduled, publishing and published as active posts', () => {
    expect([...ACTIVE_POST_STATUSES]).toEqual(['scheduled', 'publishing', 'published'])
  })

  it('picks only finite non-negative known metrics', () => {
    expect(
      pickMetrics({ views: 10, likes: '5', comments: -1, shares: Number.NaN, saves: Infinity, foo: 3, reach: '' }),
    ).toEqual({ views: 10, likes: 5 })
    expect(pickMetrics(null)).toEqual({})
    expect(pickMetrics('x')).toEqual({})
    expect(METRIC_KEYS).toContain('impressions')
  })

  it('MetricsSchema rejects unknown keys and negatives', () => {
    expect(MetricsSchema.safeParse({ views: 1 }).success).toBe(true)
    expect(MetricsSchema.safeParse({ views: -1 }).success).toBe(false)
    expect(MetricsSchema.safeParse({ clicks: 1 }).success).toBe(false)
  })
})
