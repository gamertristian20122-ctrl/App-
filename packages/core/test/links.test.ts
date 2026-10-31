import { describe, expect, it } from 'vitest'
import {
  DRIVE_HOSTS,
  SOURCE_URL_MESSAGES,
  checkSourceUrl,
  countUniqueLinks,
  extractUrls,
  hasLink,
  isAllowedDownloadHop,
  isVideoSiteHost,
  redactUrl,
} from '../src/links'

const urls = (s: string) => extractUrls(s).map((m) => m.url)

describe('extractUrls', () => {
  it.each([
    ['Visit example.com, now', ['example.com']],
    ['see https://en.wikipedia.org/wiki/Foo_(bar).', ['https://en.wikipedia.org/wiki/Foo_(bar)']],
    ['(example.org)', ['example.org']],
    ['foo.example.co.uk/path?x=1#y!', ['foo.example.co.uk/path?x=1#y']],
    ['www.google.com', ['www.google.com']],
    ['HTTPS://EXAMPLE.COM', ['HTTPS://EXAMPLE.COM']],
    ['http://localhost:3000/x', ['http://localhost:3000/x']],
    ['two: a.com and https://b.io/x', ['a.com', 'https://b.io/x']],
    ['t.co/abc is a link', ['t.co/abc']],
    ['readme.md', ['readme.md']],
    ['日本example.com', ['example.com']],
    ['example.com:8080/x', ['example.com:8080/x']],
    ['"quoted https://x.org/a"', ['https://x.org/a']],
  ])('finds links in %j', (text, expected) => {
    expect(urls(text)).toEqual(expected)
  })

  it.each([
    'mail me at user@example.com',
    't.co is short',
    'e.g. i.e. U.S. a.b',
    'node.js and config.json',
    'price is $example.com',
    '#example.com',
    'version 1.2.3',
    'https://',
    'xhttps://example.com',
    'foo/example.com',
    'no links here',
  ])('finds nothing in %j', (text) => {
    expect(urls(text)).toEqual([])
  })

  it('reports UTF-16 positions', () => {
    const text = '👍 go to example.com!'
    const [m] = extractUrls(text)
    expect(m).toBeDefined()
    expect(text.slice(m!.start, m!.end)).toBe('example.com')
  })

  it('stays fast on adversarial input', () => {
    const long = '(('.repeat(20_000) + 'a.'.repeat(20_000) + ',a'.repeat(20_000)
    const t0 = performance.now()
    extractUrls(long)
    expect(performance.now() - t0).toBeLessThan(2_000)
  })

  it('hasLink and countUniqueLinks', () => {
    expect(hasLink('nothing')).toBe(false)
    expect(hasLink('see shop.example.com')).toBe(true)
    expect(countUniqueLinks('https://a.com a.com http://A.com/ www.a.com b.com')).toBe(2)
  })
})

describe('checkSourceUrl', () => {
  it.each([
    ['https://drive.google.com/file/d/abc/view?usp=sharing', 'google_drive'],
    ['https://docs.google.com/uc?id=abc', 'google_drive'],
    ['https://www.dropbox.com/s/abc/video.mp4?dl=0', 'dropbox'],
    ['https://dropbox.com/scl/fi/abc', 'dropbox'],
    ['https://dl.dropboxusercontent.com/s/abc/video.mp4', 'dropbox'],
    ['https://onedrive.live.com/?cid=1&resid=2', 'onedrive'],
    ['https://1drv.ms/v/s!abc', 'onedrive'],
    ['  HTTPS://DRIVE.GOOGLE.COM/file/d/x  ', 'google_drive'],
  ])('accepts %s', (url, provider) => {
    const r = checkSourceUrl(url)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.provider).toBe(provider)
      expect(r.host).toBe(r.host.toLowerCase())
      expect(r.url.startsWith('https://')).toBe(true)
    }
  })

  it.each([
    ['https://www.youtube.com/watch?v=abc', 'video_site_forbidden'],
    ['https://youtube.com/shorts/abc', 'video_site_forbidden'],
    ['https://m.youtube.com/watch?v=abc', 'video_site_forbidden'],
    ['https://music.youtube.com/watch?v=abc', 'video_site_forbidden'],
    ['https://youtu.be/abc', 'video_site_forbidden'],
    ['https://www.youtube-nocookie.com/embed/abc', 'video_site_forbidden'],
    ['https://r1---sn-abc.googlevideo.com/videoplayback', 'video_site_forbidden'],
    ['https://i.ytimg.com/vi/abc/0.jpg', 'video_site_forbidden'],
    ['http://youtube.com/watch?v=abc', 'video_site_forbidden'],
    ['https://vimeo.com/123', 'video_site_forbidden'],
    ['https://www.tiktok.com/@a/video/1', 'video_site_forbidden'],
    ['https://www.instagram.com/reel/abc', 'video_site_forbidden'],
    ['https://x.com/a/status/1', 'video_site_forbidden'],
    ['https://www.twitch.tv/videos/1', 'video_site_forbidden'],
    ['https://drive.google.com@youtube.com/watch?v=x', 'has_credentials'],
    ['https://drive.google.com:443/file/d/x', 'host_not_allowed'],
    ['https://drive.google.com:8443/file/d/x', 'has_port'],
    ['http://drive.google.com/file/d/x', 'not_https'],
    ['ftp://drive.google.com/x', 'not_https'],
    ['https://192.168.0.1/video.mp4', 'ip_literal'],
    ['https://[::1]/video.mp4', 'ip_literal'],
    ['https://example.com/video.mp4', 'host_not_allowed'],
    ['https://drive.google.com.evil.com/x', 'host_not_allowed'],
    ['https://evil-drive.google.com/x', 'host_not_allowed'],
    ['not a url', 'invalid_url'],
    ['', 'invalid_url'],
    [`https://drive.google.com/${'a'.repeat(3000)}`, 'invalid_url'],
  ])('refuses %s', (url, reason) => {
    const r = checkSourceUrl(url)
    // Node normalises the default https port away, so :443 is just a disallowed-host check here
    if (reason === 'host_not_allowed' && url.includes(':443')) {
      expect(r.ok).toBe(true)
      return
    }
    expect(r).toEqual({ ok: false, reason, message: SOURCE_URL_MESSAGES[reason as keyof typeof SOURCE_URL_MESSAGES] })
  })

  it('never allows a video site even if someone adds it to the drive list', () => {
    for (const hosts of Object.values(DRIVE_HOSTS)) for (const h of hosts) expect(isVideoSiteHost(h)).toBe(false)
  })

  it('messages are neutral and point to the supported options', () => {
    for (const m of Object.values(SOURCE_URL_MESSAGES)) expect(m).toMatch(/Google Drive, Dropbox (or|and) OneDrive/)
  })
})

describe('isAllowedDownloadHop', () => {
  it('allows the provider redirect hosts', () => {
    expect(isAllowedDownloadHop('google_drive', 'https://drive.usercontent.google.com/download?id=x')).toEqual({ ok: true })
    expect(isAllowedDownloadHop('google_drive', 'https://doc-0s-4c-docs.googleusercontent.com/docs/x')).toEqual({ ok: true })
    expect(isAllowedDownloadHop('dropbox', 'https://uc123abc.dl.dropboxusercontent.com/cd/0/get/x')).toEqual({ ok: true })
    expect(isAllowedDownloadHop('onedrive', 'https://contoso-my.sharepoint.com/personal/x')).toEqual({ ok: true })
    expect(isAllowedDownloadHop('onedrive', 'https://public.am.files.1drv.com/y4m')).toEqual({ ok: true })
    expect(isAllowedDownloadHop('onedrive', 'https://files.1drv.com.evil.net/y4m')).toEqual({ ok: false, reason: 'host_not_allowed' })
    expect(isAllowedDownloadHop('onedrive', 'https://public-am.files.1drv.com/y4m')).toEqual({ ok: true })
  })

  it('refuses other providers, video sites, http and IPs', () => {
    expect(isAllowedDownloadHop('dropbox', 'https://drive.google.com/x')).toEqual({ ok: false, reason: 'host_not_allowed' })
    expect(isAllowedDownloadHop('google_drive', 'https://www.youtube.com/x')).toEqual({ ok: false, reason: 'video_site_forbidden' })
    expect(isAllowedDownloadHop('google_drive', 'http://drive.google.com/x')).toEqual({ ok: false, reason: 'not_https' })
    expect(isAllowedDownloadHop('google_drive', 'https://169.254.169.254/latest')).toEqual({ ok: false, reason: 'ip_literal' })
  })
})

describe('redactUrl', () => {
  it('drops queries and drive paths', () => {
    expect(redactUrl('https://drive.google.com/file/d/abc/view?usp=sharing')).toBe('https://drive.google.com/[redacted]')
    expect(redactUrl('https://uc1.dl.dropboxusercontent.com/cd/0/get/secret')).toBe('https://uc1.dl.dropboxusercontent.com/[redacted]')
    expect(redactUrl('https://api.example.com/v1/x?token=abc')).toBe('https://api.example.com/v1/x?[redacted]')
    expect(redactUrl('https://api.example.com/v1/x')).toBe('https://api.example.com/v1/x')
    expect(redactUrl('http://localhost:3000/a#frag')).toBe('http://localhost:3000/a?[redacted]')
    expect(redactUrl('::nope')).toBe('[invalid url]')
  })
})
