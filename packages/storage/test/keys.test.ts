import { describe, expect, it } from 'vitest'
import { ALLOWED_MIME } from '@app/core/validation'
import {
  assertValidKey,
  clipKey,
  extForMime,
  isKeyOwnedBy,
  keyOwner,
  MAX_KEY_LENGTH,
  mimeForExt,
  normalizeExt,
  parseKey,
  renderKey,
  sourceKey,
  uploadKey,
  userPrefix,
} from '../src/keys'
import { storageErrorReason } from '../src/errors'
import { MEDIA, OTHER_USER, USER } from './helpers'

describe('key helpers', () => {
  it('builds keys under users/{userId}/', () => {
    expect(sourceKey(USER, MEDIA, 'mp4')).toBe(`users/${USER}/sources/${MEDIA}.mp4`)
    expect(uploadKey(USER, MEDIA, '.MOV')).toBe(`users/${USER}/uploads/${MEDIA}.mov`)
    expect(clipKey(USER, MEDIA)).toBe(`users/${USER}/clips/${MEDIA}.mp4`)
    expect(clipKey(USER, MEDIA, 'webm')).toBe(`users/${USER}/clips/${MEDIA}.webm`)
    expect(renderKey(USER, MEDIA, 'png')).toBe(`users/${USER}/renders/${MEDIA}.png`)
    expect(userPrefix(USER)).toBe(`users/${USER}/`)
    for (const key of [sourceKey(USER, MEDIA, 'mp4'), uploadKey(USER, MEDIA, 'jpg'), clipKey(USER, MEDIA), renderKey(USER, MEDIA, 'png')]) {
      expect(key.startsWith(`users/${USER}/`)).toBe(true)
      expect(assertValidKey(key)).toBe(key)
    }
  })

  it('lower-cases ids', () => {
    expect(sourceKey(USER.toUpperCase(), MEDIA.toUpperCase(), 'mp4')).toBe(`users/${USER}/sources/${MEDIA}.mp4`)
  })

  it('rejects ids that are not UUIDs and odd extensions', () => {
    const bad: Array<() => string> = [
      () => sourceKey('../etc', MEDIA, 'mp4'),
      () => sourceKey(USER, 'x/y', 'mp4'),
      () => sourceKey(USER, MEDIA, ''),
      () => sourceKey(USER, MEDIA, 'mp4/../../x'),
      () => sourceKey(USER, MEDIA, 'toolongext'),
      () => userPrefix(''),
    ]
    for (const fn of bad) {
      let error: unknown
      try {
        fn()
      } catch (e) {
        error = e
      }
      expect(storageErrorReason(error)).toBe('invalid_key')
    }
    expect(normalizeExt(' .JPEG ')).toBe('jpeg')
  })

  it('parses keys built by the helpers', () => {
    expect(parseKey(clipKey(USER, MEDIA))).toEqual({ userId: USER, area: 'clips', id: MEDIA, ext: 'mp4' })
    expect(parseKey(`users/${USER}/other/${MEDIA}.mp4`)).toBeNull()
    expect(parseKey('nope')).toBeNull()
  })

  it('checks ownership', () => {
    const key = uploadKey(USER, MEDIA, 'mp4')
    expect(isKeyOwnedBy(key, USER)).toBe(true)
    expect(isKeyOwnedBy(key, OTHER_USER)).toBe(false)
    expect(isKeyOwnedBy('users/../x', USER)).toBe(false)
    expect(isKeyOwnedBy(key, 'garbage')).toBe(false)
    expect(keyOwner(key)).toBe(USER)
    expect(keyOwner('bad')).toBeNull()
  })

  it('rejects traversal, hidden segments, empty segments and foreign prefixes', () => {
    const bad = [
      'x.mp4',
      `/users/${USER}/a.mp4`,
      `users/${USER}`,
      `users/${USER}/`,
      `users/${USER}/a//b.mp4`,
      `users/${USER}/../${OTHER_USER}/a.mp4`,
      `users/${USER}/./a.mp4`,
      `users/${USER}/.env`,
      `users/${USER}/a/`,
      `users/${USER}/a b.mp4`,
      `users/${USER}/a\\b.mp4`,
      `users/${USER}/a%2F..%2Fb`,
      `users/${MEDIA.toUpperCase()}/a.mp4`,
      `users/${USER}/${'a'.repeat(MAX_KEY_LENGTH)}`,
      `users/${USER}/a\0.mp4`,
    ]
    for (const key of bad) expect(() => assertValidKey(key), key).toThrow()
    expect(() => assertValidKey(42)).toThrow()
    expect(() => assertValidKey(undefined)).toThrow()
    expect(assertValidKey(`users/${USER}/misc/a-b_c.d.json`)).toBe(`users/${USER}/misc/a-b_c.d.json`)
  })

  it('maps every accepted upload MIME type to an extension and back', () => {
    for (const mimes of Object.values(ALLOWED_MIME)) {
      for (const mime of mimes) {
        const ext = extForMime(mime)
        expect(ext, mime).toMatch(/^[a-z0-9]{1,8}$/)
        expect(mimeForExt(ext as string), mime).not.toBeNull()
      }
    }
    expect(extForMime('video/mp4; codecs="avc1"')).toBe('mp4')
    expect(extForMime('image/svg+xml')).toBeNull()
    expect(mimeForExt('.PNG')).toBe('image/png')
    expect(mimeForExt('exe')).toBeNull()
  })
})
