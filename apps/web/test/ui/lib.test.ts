// Pure UI helpers: formatting, time zones, safe paths, form readers, action results and the
// browser upload flow (with mocked fetch / PUT; no network).

import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@app/core/errors'
import { failure, isNavigationError } from '@/lib/ui/action-result'
import { isServiceError } from '@/lib/ui/errors'
import { scheduleAt } from '@/lib/ui/actions/drafts'
import { blocks, checkbox, id, integer, lines, platform, text, timeZone } from '@/lib/ui/form'
import { excerpt, formatBytes, formatChange, formatClipHours, formatCount, formatDuration, formatTimestamp, percentOf, plural, safeTimeZone } from '@/lib/ui/format'
import { param, safeExternalUrl, safeNextPath, withQuery } from '@/lib/ui/paths'
import { addDaysToKey, dayKey, isDayKey, monthRange, timeZoneOptions, toLocalInputValue, weekRange, zonedLocalToUtc } from '@/lib/ui/time'
import { contentTypeFor, normalizeUploadResponse, safePutHeaders, uploadFile, UploadError, type UploadDeps } from '@/lib/ui/upload'
import { form } from './harness'

describe('format', () => {
  it('formats durations, timestamps, bytes, hours, counts and changes', () => {
    expect(formatDuration(3_723_000)).toBe('1:02:03')
    expect(formatDuration(65_000)).toBe('1:05')
    expect(formatDuration(null)).toBe('—')
    expect(formatTimestamp(62_500)).toBe('1:02.5')
    expect(formatTimestamp(3_600_000)).toBe('1:00:00')
    expect(formatBytes(1_500_000_000)).toBe('1.5 GB')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatClipHours(5_400)).toBe('1.5 h')
    expect(formatClipHours(14_400)).toBe('4 h')
    expect(formatClipHours(120)).toBe('2 min')
    expect(formatClipHours(0)).toBe('0 h')
    expect(formatCount(1234)).toBe('1,234')
    expect(formatCount(12_345)).toBe('12.3K')
    expect(formatChange(12.5)).toBe('+12.5%')
    expect(formatChange(-3)).toBe('−3%')
    expect(formatChange(null)).toBe('—')
    expect(plural(1, 'brand')).toBe('1 brand')
    expect(plural(2, 'match', 'matches')).toBe('2 matches')
    expect(excerpt('a  b\n c', 10)).toBe('a b c')
    expect(excerpt('x'.repeat(20), 10)).toBe(`${'x'.repeat(9)}…`)
    expect(percentOf(3, 4)).toBe(75)
    expect(percentOf(1, 0)).toBe(100)
    expect(percentOf(9, 4)).toBe(100)
    expect(safeTimeZone('Not/AZone')).toBe('UTC')
  })
})

describe('time', () => {
  it('converts wall-clock times in a zone to UTC, across DST', () => {
    expect(zonedLocalToUtc('2026-11-03T09:30', 'America/New_York')?.toISOString()).toBe('2026-11-03T14:30:00.000Z')
    expect(zonedLocalToUtc('2026-07-03T09:30', 'America/New_York')?.toISOString()).toBe('2026-07-03T13:30:00.000Z')
    expect(zonedLocalToUtc('2026-03-29T02:30', 'Europe/Berlin')?.toISOString()).toBe('2026-03-29T01:30:00.000Z') // spring-forward gap
    expect(zonedLocalToUtc('2026-11-03T09:30', 'Asia/Kolkata')?.toISOString()).toBe('2026-11-03T04:00:00.000Z')
    expect(zonedLocalToUtc('2026-02-30T09:30', 'UTC')).toBeNull()
    expect(zonedLocalToUtc('tomorrow', 'UTC')).toBeNull()
    expect(toLocalInputValue(new Date('2026-11-03T14:30:00Z'), 'America/New_York')).toBe('2026-11-03T09:30')
  })

  it('builds week and month ranges of day keys', () => {
    expect(dayKey(new Date('2026-11-03T03:00:00Z'), 'America/New_York')).toBe('2026-11-02')
    expect(isDayKey('2026-02-29')).toBe(false)
    expect(isDayKey('2028-02-29')).toBe(true)
    expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01')
    const week = weekRange('2026-11-05', 'UTC')
    expect(week.startKey).toBe('2026-11-02')
    expect(week.endKey).toBe('2026-11-09')
    expect(week.days).toHaveLength(7)
    expect(week.from.toISOString()).toBe('2026-11-02T00:00:00.000Z')
    const month = monthRange('2026-12-15', 'America/New_York')
    expect(month.startKey).toBe('2026-12-01')
    expect(month.endKey).toBe('2027-01-01')
    expect(month.days).toHaveLength(31)
    expect(month.from.toISOString()).toBe('2026-12-01T05:00:00.000Z')
    expect(timeZoneOptions()[0]).toBe('UTC')
    expect(timeZoneOptions('Etc/GMT+5')).toContain('Etc/GMT+5')
  })
})

describe('paths', () => {
  it('keeps ?next= on this site', () => {
    expect(safeNextPath('/app/approvals?draft=1#x')).toBe('/app/approvals?draft=1#x')
    expect(safeNextPath('//evil.example')).toBe('/app')
    expect(safeNextPath('https://evil.example/app')).toBe('/app')
    expect(safeNextPath('/\\evil')).toBe('/app')
    expect(safeNextPath(undefined)).toBe('/app')
    expect(param({ a: ['1', '2'] }, 'a')).toBe('1')
    expect(withQuery('/x', { a: 1, b: null, c: '' })).toBe('/x?a=1')
    expect(safeExternalUrl('https://x.com/acme/status/1')).toBe('https://x.com/acme/status/1')
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(safeExternalUrl(null)).toBeNull()
  })
})

describe('form readers', () => {
  it('parse ids, platforms, zones, numbers, lists and blocks defensively', () => {
    const fd = form({
      id: '3F2504E0-4F89-11D3-9A0C-0305E82C3301',
      bad: 'nope',
      p: 'linkedin',
      q: 'myspace',
      tz: 'Europe/Paris',
      tz2: 'Mars/Base',
      n: '12',
      m: '1.5',
      on: 'on',
      list: ' a \n\n b ',
      blocks: 'one\n---\ntwo\n  ---  \nthree',
      long: 'x'.repeat(50),
    })
    expect(id(fd, 'id')).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301')
    expect(id(fd, 'bad')).toBeNull()
    expect(platform(fd, 'p')).toBe('linkedin')
    expect(platform(fd, 'q')).toBeNull()
    expect(timeZone(fd, 'tz')).toBe('Europe/Paris')
    expect(timeZone(fd, 'tz2')).toBeNull()
    expect(integer(fd, 'n', 0, 20)).toBe(12)
    expect(integer(fd, 'm', 0, 20)).toBeNull()
    expect(integer(fd, 'missing', 0, 20)).toBeUndefined()
    expect(checkbox(fd, 'on')).toBe(true)
    expect(checkbox(fd, 'missing')).toBe(false)
    expect(lines(fd, 'list')).toEqual(['a', 'b'])
    expect(blocks(fd, 'blocks')).toEqual(['one', 'two', 'three'])
    expect(text(fd, 'long', { max: 10 })).toBeUndefined()
  })

  it('reads schedule times as "now", or local time in the submitted (or fallback) zone', () => {
    expect(scheduleAt(form({ now: 'on' }), 'UTC')).toBe('now')
    expect(scheduleAt(form({ when: '2026-11-03T09:30', tz: 'America/Los_Angeles' }), 'UTC')).toBe('2026-11-03T17:30:00.000Z')
    expect(scheduleAt(form({ when: '2026-11-03T09:30', tz: 'bogus' }), 'Europe/London')).toBe('2026-11-03T09:30:00.000Z')
    expect(scheduleAt(form({}), 'UTC')).toBeNull()
  })
})

describe('action results', () => {
  it('passes AppError messages and issues through and hides everything else', () => {
    const r = failure(new AppError('validation', 'Draft is invalid.', { issues: [{ path: 'text', message: 'Too long.' }], problems: ['Brand inactive.'] }))
    expect(r).toMatchObject({ ok: false, message: 'Draft is invalid.', issues: ['Brand inactive.', 'Too long.'] })
    expect(failure(new Error('password=hunter2'))).toMatchObject({ ok: false, message: 'Something went wrong. Please try again.' })
    // an AppError from another bundle's copy of the class (the cached services may come from a route handler)
    class ForeignAppError extends Error {
      override name = 'AppError'
      constructor(readonly code: string, message: string) {
        super(message)
      }
    }
    expect(failure(new ForeignAppError('conflict', 'Already published.'))).toMatchObject({ ok: false, message: 'Already published.' })
    expect(failure(new ForeignAppError('made_up', 'Leaky internals.'))).toMatchObject({ message: 'Something went wrong. Please try again.' })
    expect(isServiceError(new ForeignAppError('not_found', 'x'), ['not_found', 'unauthorized'])).toBe(true)
    expect(isServiceError(new ForeignAppError('not_found', 'x'), 'validation')).toBe(false)
    expect(isNavigationError({ digest: 'NEXT_REDIRECT;replace;/x;307;' })).toBe(true)
    expect(isNavigationError(new Error('x'))).toBe(false)
  })
})

describe('upload flow', () => {
  const mediaId = '11111111-2222-4333-8444-555555555555'

  it('normalizes both upload contracts', () => {
    expect(normalizeUploadResponse({ mediaId, uploadUrl: 'https://r2/put', headers: { 'content-type': 'video/mp4', bad: 1 } })).toEqual({
      mode: 'single',
      mediaId,
      url: 'https://r2/put',
      headers: { 'content-type': 'video/mp4' },
    })
    expect(normalizeUploadResponse({ media: { id: mediaId }, upload: { mode: 'single', url: 'https://r2/put', headers: {} } })?.mode).toBe('single')
    const multi = normalizeUploadResponse({
      media: { id: mediaId },
      upload: { mode: 'multipart', uploadId: 'up1', parts: [{ partNumber: 1, bytes: 5, url: 'https://r2/1', headers: {} }] },
    })
    expect(multi).toMatchObject({ mode: 'multipart', uploadId: 'up1', parts: [{ partNumber: 1, bytes: 5 }] })
    expect(normalizeUploadResponse({ media: {}, upload: {} })).toBeNull()
    expect(normalizeUploadResponse('nope')).toBeNull()
  })

  it('guesses content types and drops headers the browser sets itself', () => {
    expect(contentTypeFor({ name: 'talk.MKV', type: '' })).toBe('video/x-matroska')
    expect(contentTypeFor({ name: 'a.mp4', type: 'video/mp4' })).toBe('video/mp4')
    expect(contentTypeFor({ name: 'a.svg', type: 'image/svg+xml' })).toBeNull()
    expect(safePutHeaders({ 'Content-Type': 'video/mp4', 'Content-Length': '5' })).toEqual({ 'Content-Type': 'video/mp4' })
  })

  function deps(responses: Record<string, Response>, put: UploadDeps['put']): UploadDeps & { calls: Array<{ url: string; body: unknown }> } {
    const calls: Array<{ url: string; body: unknown }> = []
    return {
      calls,
      fetch: async (url, init) => {
        calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
        const res = responses[url]
        if (!res) throw new Error(`unexpected ${url}`)
        return res
      },
      put,
    }
  }

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('starts, PUTs and completes a single upload', async () => {
    const put = vi.fn<UploadDeps['put']>(async (_url, _body, _headers, onProgress) => {
      onProgress(5)
      return { ok: true, status: 200, etag: '"e"' }
    })
    const d = deps(
      {
        '/api/uploads': json({ media: { id: mediaId }, upload: { mode: 'single', url: 'https://r2/put', headers: { 'content-type': 'video/mp4' } } }, 201),
        [`/api/uploads/${mediaId}/complete`]: json({ media: { id: mediaId }, ingestQueued: true }),
      },
      put,
    )
    const file = Object.assign(new Blob(['hello'], { type: 'video/mp4' }), { name: 'talk.mp4' })
    const progress: number[] = []
    const result = await uploadFile({ file, purpose: 'clip_source', brandId: null, rightsAttested: true }, d, (f) => progress.push(f))
    expect(result).toEqual({ mediaId, ingestQueued: true })
    expect(d.calls[0]?.body).toEqual({ purpose: 'clip_source', filename: 'talk.mp4', contentType: 'video/mp4', bytes: 5, rightsAttested: true })
    expect(put).toHaveBeenCalledWith('https://r2/put', file, { 'content-type': 'video/mp4' }, expect.any(Function))
    expect(d.calls[1]?.body).toEqual({})
    expect(progress.at(-1)).toBe(1)
  })

  it('uploads multipart parts and completes with their ETags', async () => {
    const etags = ['"a"', '"b"']
    const put = vi.fn<UploadDeps['put']>(async () => ({ ok: true, status: 200, etag: etags.shift() ?? null }))
    const d = deps(
      {
        '/api/uploads': json({
          media: { id: mediaId },
          upload: { mode: 'multipart', uploadId: 'up-1', parts: [{ partNumber: 1, bytes: 3, url: 'https://r2/1', headers: {} }, { partNumber: 2, bytes: 2, url: 'https://r2/2', headers: {} }] },
        }),
        [`/api/uploads/${mediaId}/complete`]: json({ ingestQueued: true }),
      },
      put,
    )
    const file = Object.assign(new Blob(['hello'], { type: 'video/mp4' }), { name: 'big.mp4' })
    await uploadFile({ file, purpose: 'post', rightsAttested: false }, d)
    expect(put).toHaveBeenCalledTimes(2)
    expect(d.calls[1]?.body).toEqual({ uploadId: 'up-1', parts: [{ partNumber: 1, etag: '"a"' }, { partNumber: 2, etag: '"b"' }] })
  })

  it('surfaces server messages and refuses unattested clip sources before uploading', async () => {
    const put = vi.fn<UploadDeps['put']>()
    const d = deps({ '/api/uploads': json({ error: { code: 'limit_exceeded', message: 'Your storage is full.' } }, 409) }, put)
    const file = Object.assign(new Blob(['x'], { type: 'image/png' }), { name: 'a.png' })
    await expect(uploadFile({ file, purpose: 'post', rightsAttested: false }, d)).rejects.toThrow('Your storage is full.')
    await expect(uploadFile({ file, purpose: 'clip_source', rightsAttested: false }, d)).rejects.toBeInstanceOf(UploadError)
    const svg = Object.assign(new Blob(['<svg/>'], { type: 'image/svg+xml' }), { name: 'a.svg' })
    await expect(uploadFile({ file: svg, purpose: 'post', rightsAttested: true }, d)).rejects.toThrow('not supported')
    expect(put).not.toHaveBeenCalled()

    const failingPut = vi.fn<UploadDeps['put']>(async () => ({ ok: false, status: 403, etag: null }))
    const d2 = deps({ '/api/uploads': json({ mediaId, uploadUrl: 'https://r2/put', headers: {} }) }, failingPut)
    await expect(uploadFile({ file, purpose: 'post', rightsAttested: false }, d2)).rejects.toThrow('status 403')
  })
})
