// Server-action logic for brands, connected accounts, media, clips, the voice profile and
// connected AI apps. Each function reads the form, calls one services function (which validates
// the input with the core zod schemas and enforces plan limits) and returns a short result.
// Server-only.

import { CAPTION_STYLES, EMOJI_POLICIES, HASHTAG_POLICIES } from '@app/core/validation'
import { PLATFORM_LABELS, type Platform } from '@app/core/types'
import type { Services } from '@app/services'
import { failed, failure, success, type ActionResult } from '../action-result'
import { blocks, checkbox, id, lines, nonEmpty, platform, text, timeZone, type Fields } from '../form'

const MISSING = 'This page is out of date. Reload it and try again.'

// ---------------------------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------------------------

export async function createBrand(services: Services, userId: string, fd: Fields): Promise<ActionResult> {
  const name = text(fd, 'name', { max: 500 }) ?? ''
  const tz = timeZone(fd, 'timezone')
  try {
    const brand = await services.brands.create(userId, { name, ...(tz ? { timezone: tz } : {}) }, { via: 'web' })
    return success(`Created “${brand.name}”. Connect its accounts next.`)
  } catch (error) {
    return failure(error)
  }
}

export async function updateBrand(services: Services, userId: string, fd: Fields): Promise<ActionResult> {
  const brandId = id(fd, 'brandId')
  if (!brandId) return failed(MISSING)
  const name = nonEmpty(fd, 'name', { max: 500 })
  const tz = timeZone(fd, 'timezone')
  if (!name && !tz) return failed('Nothing to change.')
  try {
    await services.brands.update(userId, brandId, { ...(name ? { name } : {}), ...(tz ? { timezone: tz } : {}) }, { via: 'web' })
    return success('Saved.')
  } catch (error) {
    return failure(error)
  }
}

export async function archiveBrand(services: Services, userId: string, fd: Fields): Promise<ActionResult> {
  const brandId = id(fd, 'brandId')
  if (!brandId) return failed(MISSING)
  try {
    const brand = await services.brands.archive(userId, brandId, { via: 'web' })
    return success(`Archived “${brand.name}”. Its scheduled posts were canceled and its accounts disconnected.`)
  } catch (error) {
    return failure(error)
  }
}

export async function restoreBrand(services: Services, userId: string, fd: Fields): Promise<ActionResult> {
  const brandId = id(fd, 'brandId')
  if (!brandId) return failed(MISSING)
  try {
    const brand = await services.brands.restore(userId, brandId, { via: 'web' })
    return success(`Restored “${brand.name}”. Reconnect its accounts to publish again.`)
  } catch (error) {
    return failure(error)
  }
}

// ---------------------------------------------------------------------------------------------
// Connected accounts
// ---------------------------------------------------------------------------------------------

/** Creates a hosted connect link; the caller redirects the browser to `url`. */
export async function connectAccount(
  services: Services,
  userId: string,
  fd: Fields,
  appUrl: string,
): Promise<{ result: ActionResult; url?: string }> {
  const brandId = id(fd, 'brandId')
  const p = platform(fd, 'platform')
  if (!brandId || !p) return { result: failed(MISSING) }
  const back = new URL('/app/accounts', appUrl)
  back.searchParams.set('brand', brandId)
  back.searchParams.set('connected', p)
  try {
    const link = await services.accounts.connectLink(userId, { brandId, platform: p }, { redirectUrl: back.toString(), via: 'web' })
    return { result: success(`Opening the ${PLATFORM_LABELS[p]} connection page…`), url: link.url }
  } catch (error) {
    return { result: failure(error) }
  }
}

export async function syncAccounts(services: Services, userId: string, fd: Fields): Promise<ActionResult> {
  const brandId = id(fd, 'brandId')
  if (!brandId) return failed(MISSING)
  try {
    const result = await services.accounts.sync(userId, brandId, { via: 'web' })
    const parts: string[] = []
    if (result.connected.length > 0) parts.push(`connected ${result.connected.map((p) => PLATFORM_LABELS[p]).join(', ')}`)
    if (result.disconnected.length > 0) parts.push(`disconnected ${result.disconnected.map((p) => PLATFORM_LABELS[p]).join(', ')}`)
    return success(parts.length > 0 ? `Accounts refreshed: ${parts.join('; ')}.` : 'Accounts are up to date.')
  } catch (error) {
    return failure(error)
  }
}

export async function disconnectAccount(services: Services, userId: string, fd: Fields): Promise<ActionResult> {
  const accountId = id(fd, 'accountId')
  if (!accountId) return failed(MISSING)
  try {
    const account = await services.accounts.disconnect(userId, accountId, { via: 'web' })
    return success(`Disconnected ${PLATFORM_LABELS[account.platform]}. Its scheduled posts were canceled.`)
  } catch (error) {
    return failure(error)
  }
}

// ---------------------------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------------------------

/** Registers a Google Drive / Dropbox / OneDrive link to the user's own video as a clip source. */
export async function addDriveLink(services: Services, userId: string, fd: Fields): Promise<ActionResult> {
  const url = text(fd, 'url', { max: 4096 }) ?? ''
  const brandId = id(fd, 'brandId')
  try {
    await services.media.registerDriveLink(
      userId,
      { url, rightsAttested: checkbox(fd, 'rightsAttested'), ...(brandId ? { brandId } : {}) },
      { via: 'web' },
    )
    return success('Link added. We are fetching the video; it appears below when it is ready.')
  } catch (error) {
    return failure(error)
  }
}

export async function deleteMedia(services: Services, userId: string, fd: Fields): Promise<ActionResult> {
  const mediaId = id(fd, 'mediaId')
  if (!mediaId) return failed(MISSING)
  try {
    await services.media.remove(userId, mediaId, { via: 'web' })
    return success('Deleted.')
  } catch (error) {
    return failure(error)
  }
}

// ---------------------------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------------------------

/** One clip from a source video (start/end as "1:02", "1:02.5" or seconds). */
export async function requestClip(services: Services, userId: string, fd: Fields): Promise<ActionResult> {
  const mediaId = id(fd, 'mediaId')
  if (!mediaId) return failed(MISSING)
  const start = text(fd, 'start', { max: 20 }) ?? ''
  const end = text(fd, 'end', { max: 20 }) ?? ''
  const title = nonEmpty(fd, 'title', { max: 500 })
  const hook = nonEmpty(fd, 'hook', { max: 1_000 })
  const style = text(fd, 'captionStyle', { max: 20 })
  const captionStyle = CAPTION_STYLES.find((s) => s === style) ?? 'bold'
  const brandId = id(fd, 'brandId')
  try {
    const clips = await services.clips.requestClips(
      userId,
      {
        mediaId,
        ...(brandId ? { brandId } : {}),
        ranges: [{ startMs: start, endMs: end, ...(title ? { title } : {}), ...(hook ? { hook } : {}) }],
        captionStyle,
      },
      { via: 'web' },
    )
    return success(clips.length === 1 ? 'Clip queued. A draft appears in your approvals when it is rendered.' : `${clips.length} clips queued.`)
  } catch (error) {
    return failure(error)
  }
}

// ---------------------------------------------------------------------------------------------
// Voice profile
// ---------------------------------------------------------------------------------------------

const PLATFORM_PREFIX = /^\[(\w+)\]\s*/

/** Builds the voice profile JSON from the structured form (lists one per line; samples split by ---). */
export function voiceProfileFromForm(fd: Fields): Record<string, unknown> {
  const emoji = text(fd, 'emoji_policy', { max: 20 })
  const hashtags = text(fd, 'hashtag_policy', { max: 20 })
  const samples = blocks(fd, 'sample_posts').map((block) => {
    const m = PLATFORM_PREFIX.exec(block)
    const p = m?.[1]?.toLowerCase()
    if (m && p && p in PLATFORM_LABELS) return { platform: p as Platform, text: block.slice(m[0].length).trim() }
    return { text: block }
  })
  return {
    tone: text(fd, 'tone', { max: 5_000 }) ?? '',
    audience: text(fd, 'audience', { max: 5_000 }) ?? '',
    vocabulary: lines(fd, 'vocabulary'),
    do: lines(fd, 'do'),
    dont: lines(fd, 'dont'),
    emoji_policy: EMOJI_POLICIES.find((e) => e === emoji) ?? 'sparing',
    hashtag_policy: HASHTAG_POLICIES.find((h) => h === hashtags) ?? 'few',
    sample_posts: samples,
  }
}

export async function saveVoiceProfile(services: Services, userId: string, fd: Fields): Promise<ActionResult> {
  const brandId = id(fd, 'brandId')
  if (!brandId) return failed(MISSING)
  try {
    const saved = await services.voice.save(userId, { brandId, profile: voiceProfileFromForm(fd), source: 'manual' }, { via: 'web' })
    return success(`Saved as version ${saved.version}. Your AI uses it for every new draft.`)
  } catch (error) {
    return failure(error)
  }
}

/** Saves the profile from the raw JSON editor (validated by services with the core schema). */
export async function saveVoiceProfileJson(services: Services, userId: string, fd: Fields): Promise<ActionResult> {
  const brandId = id(fd, 'brandId')
  if (!brandId) return failed(MISSING)
  const raw = text(fd, 'json', { max: 300_000 }) ?? ''
  let profile: unknown
  try {
    profile = JSON.parse(raw)
  } catch {
    return failed('That is not valid JSON.')
  }
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return failed('The profile must be a JSON object.')
  try {
    const saved = await services.voice.save(userId, { brandId, profile, source: 'manual' }, { via: 'web' })
    return success(`Saved as version ${saved.version}.`)
  } catch (error) {
    return failure(error)
  }
}

// ---------------------------------------------------------------------------------------------
// Connected AI apps (OAuth grants for the MCP server)
// ---------------------------------------------------------------------------------------------

export async function revokeAiConnection(services: Services, userId: string, fd: Fields): Promise<ActionResult> {
  const familyId = text(fd, 'familyId', { max: 100 })
  if (!familyId) return failed(MISSING)
  try {
    await services.oauth.revokeConnection(userId, familyId)
    return success('Disconnected. That app must sign in again to use your account.')
  } catch (error) {
    return failure(error)
  }
}
