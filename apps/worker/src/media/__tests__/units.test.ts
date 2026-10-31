// Pure parts of the media handlers: captions (ASS), ffmpeg argument builders, ffprobe parsing,
// share-link conversion, the guarded drive download (mocked fetch), the process runner, templates.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppError } from '@app/core/errors'
import { SOURCE_URL_MESSAGES } from '@app/core/links'
import { transcriptionError } from '@app/transcription'
import { JobAbortedError, PermanentJobError } from '../../errors'
import { assTime, buildAss, cleanWord, groupCaptionLines } from '../captions'
import { DRIVE_MESSAGES, IngestRefusal, TransientDownloadError, directDownloadUrl, downloadDriveFile, type FetchLike } from '../drive'
import { chooseFraming, clipFilterGraph, clipRenderArgs, extractAudioArgs, fileInput, outputFps, sec, slideshowPlan, urlInput } from '../ffmpeg'
import { hashFile, withTempDir } from '../files'
import { isRetryableMediaError } from '../options'
import { MediaToolError, runTool, toolEnv } from '../process'
import { parseProbe, parseRate } from '../probe'
import { carouselSlideHtml, contrastOn, escapeHtml, resolveTheme, videoSlideHtml } from '../templates'
import { fileResponse, redirectResponse } from './fixtures'

const words = (text: string, start = 0, step = 400) =>
  text.split(' ').map((t, i) => ({ s: start + i * step, e: start + i * step + 300, t }))

describe('captions', () => {
  it('groups words into lines of 2–4 words, breaking at sentence ends', () => {
    const lines = groupCaptionLines(words('Here is the mistake. Almost every creator makes it with long videos'))
    expect(lines.map((l) => l.words.map((w) => w.t).join(' '))).toEqual(['Here is the mistake.', 'Almost every', 'creator makes it', 'with long videos'])
    for (const line of lines) {
      expect(line.words.length).toBeGreaterThanOrEqual(2)
      expect(line.words.length).toBeLessThanOrEqual(4)
    }
  })

  it('breaks lines at long pauses and at the character budget', () => {
    const w = [
      { s: 0, e: 300, t: 'Wait' },
      { s: 2000, e: 2300, t: 'extraordinarily' },
      { s: 2400, e: 2700, t: 'complicated' },
    ]
    const lines = groupCaptionLines(w, { maxChars: 18 })
    expect(lines.map((l) => l.words.map((x) => x.t))).toEqual([['Wait'], ['extraordinarily'], ['complicated']])
  })

  it('strips ASS override characters from words', () => {
    expect(cleanWord('{\\an8}hi\\N')).toBe('an8 hi N')
    expect(cleanWord('  ok\u0000 ')).toBe('ok')
  })

  it('formats ASS timestamps', () => {
    expect(assTime(0)).toBe('0:00:00.00')
    expect(assTime(61_234)).toBe('0:01:01.23')
    expect(assTime(3_600_000 + 5)).toBe('1:00:00.00')
  })

  it('builds a 1080×1920 ASS file with a per-word highlight in the safe area', () => {
    const ass = buildAss(words('one two three four five six'), { style: 'bold', durationMs: 3_000 })
    expect(ass).not.toBeNull()
    expect(ass).toContain('PlayResX: 1080')
    expect(ass).toContain('PlayResY: 1920')
    expect(ass).toMatch(/Style: Caption,Noto Sans,84,/)
    // bottom margin keeps captions above platform UI
    expect(ass).toMatch(/,2,110,150,540,1\n/)
    const events = ass!.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(events.length).toBe(6)
    expect(events[0]).toContain('{\\1c&H0000E5FF&\\fscx108\\fscy108}one{\\r} two three four')
    expect(events[1]).toContain('one {\\1c&H0000E5FF&\\fscx108\\fscy108}two{\\r} three four')
  })

  it('minimal captions show whole lines; none and empty transcripts produce no file', () => {
    const minimal = buildAss(words('one two three'), { style: 'minimal', durationMs: 3_000 })
    expect(minimal?.split('\n').filter((l) => l.startsWith('Dialogue:'))).toHaveLength(1)
    expect(minimal).toContain(',3,14,0,2,')
    expect(buildAss(words('one two'), { style: 'none', durationMs: 3_000 })).toBeNull()
    expect(buildAss([], { style: 'bold', durationMs: 3_000 })).toBeNull()
  })

  it('karaoke keeps spoken words highlighted', () => {
    const ass = buildAss(words('alpha beta gamma'), { style: 'karaoke', durationMs: 3_000 })!
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(events[2]).toContain('{\\1c&H0055E07A&}alpha{\\r} {\\1c&H0055E07A&}beta{\\r} {\\1c&H0055E07A&}gamma{\\r}')
  })

  it('never shows captions past the end of the clip', () => {
    const ass = buildAss([{ s: 2_500, e: 3_400, t: 'late' }], { style: 'bold', durationMs: 3_000 })!
    expect(ass).toContain('Dialogue: 0,0:00:02.50,0:00:03.00,')
  })
})

describe('ffmpeg arguments', () => {
  it('center-crops landscape and ~9:16 sources and blurs portrait, square and narrow ones', () => {
    expect(chooseFraming(1920, 1080)).toBe('crop')
    expect(chooseFraming(1080, 1920)).toBe('crop')
    expect(chooseFraming(720, 1280)).toBe('crop')
    expect(chooseFraming(1080, 1350)).toBe('blur')
    expect(chooseFraming(1080, 1080)).toBe('blur')
    expect(chooseFraming(400, 1600)).toBe('blur')
  })

  it('keeps output frame rates within 24–60', () => {
    expect(outputFps(29.97)).toBe(30)
    expect(outputFps(120)).toBe(60)
    expect(outputFps(12)).toBe(24)
    expect(outputFps(null)).toBe(30)
  })

  it('builds the clip command as an argument array with an accurate input seek', () => {
    const args = clipRenderArgs({
      input: fileInput('/tmp/x/source.media', 'mov'),
      startMs: 61_500,
      durationMs: 30_000,
      hasAudio: false,
      framing: 'blur',
      fps: 30,
      captionsFile: 'captions.ass',
      output: 'clip.mp4',
    })
    const i = args.indexOf('-i')
    expect(args.slice(0, i)).toEqual(expect.arrayContaining(['-protocol_whitelist', 'file', '-f', 'mov', '-ss', '61.500', '-t', '30.000']))
    expect(args[i + 1]).toBe('/tmp/x/source.media')
    expect(args).toContain('anullsrc=channel_layout=stereo:sample_rate=48000')
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart', '-map_metadata', '-1']))
    expect(args.at(-1)).toBe('clip.mp4')
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph).toContain('boxblur')
    expect(graph).toContain(',ass=captions.ass[v]')
  })

  it('crop graphs fill 1080×1920 without captions when there are none', () => {
    const graph = clipFilterGraph({ framing: 'crop', fps: 30 })
    expect(graph).toContain('scale=1080:1920')
    expect(graph).not.toContain('ass=')
  })

  it('remote inputs whitelist only https and reconnect', () => {
    const input = urlInput('https://bucket.example/k?X-Amz-Signature=abc', 'mov')
    expect(input.args).toEqual(expect.arrayContaining(['-protocol_whitelist', 'https,tls,tcp', '-reconnect', '1', '-f', 'mov']))
    expect(input.remote).toBe(true)
  })

  it('extracts 16 kHz mono audio capped at the duration', () => {
    const args = extractAudioArgs({ input: fileInput('in.media', 'matroska'), maxDurationMs: 5_000, output: 'audio.mp3' })
    expect(args).toEqual(expect.arrayContaining(['-ac', '1', '-ar', '16000', '-vn', '-t', '5.000']))
    expect(args.at(-1)).toBe('audio.mp3')
  })

  it('plans slideshow segments whose frame counts add up to the total', () => {
    const plan = slideshowPlan({
      slides: [
        { path: 'a.png', durationMs: 1_000 },
        { path: 'b.png', durationMs: 1_234 },
        { path: 'c.png', durationMs: 2_000 },
      ],
      width: 1080,
      height: 1920,
      fps: 30,
      output: 'video.mp4',
    })
    expect(plan.totalMs).toBe(4_234)
    expect(plan.transitionMs).toBe(500)
    expect(plan.segments.reduce((n, s) => n + s.frames, 0)).toBe(Math.round((4_234 * 30) / 1000))
    expect(plan.segments[0]!.args.join(' ')).not.toContain('xfade')
    expect(plan.segments[1]!.args.join(' ')).toContain('xfade=transition=fade:duration=0.500:offset=0')
    expect(plan.concatList).toBe("file 'seg-000.mp4'\nfile 'seg-001.mp4'\nfile 'seg-002.mp4'\n")
    expect(plan.finalArgs).toEqual(expect.arrayContaining(['-f', 'concat', '-safe', '1', '-t', sec(4_234)]))
  })

  it('shortens crossfades for short slides', () => {
    const plan = slideshowPlan({ slides: [{ path: 'a.png', durationMs: 1_000 }, { path: 'b.png', durationMs: 1_000 }], width: 10, height: 10, output: 'o.mp4', transitionMs: 900 })
    expect(plan.transitionMs).toBe(500)
  })
})

describe('ffprobe parsing', () => {
  const probeJson = (format: Record<string, unknown>, streams: unknown[]) => JSON.stringify({ format, streams })

  it('reads duration, display size with rotation, frame rate and the container', () => {
    const result = parseProbe(
      probeJson({ format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.345', tags: { major_brand: 'qt  ' } }, [
        { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30000/1001', side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] },
        { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
      ]),
    )
    expect(result).toMatchObject({ demuxer: 'mov', durationMs: 12_345, mimeType: 'video/quicktime' })
    expect(result.video).toMatchObject({ width: 1920, height: 1080, displayWidth: 1080, displayHeight: 1920, rotation: 270 })
    expect(result.video?.fps).toBeCloseTo(29.97, 2)
    expect(result.audio).toMatchObject({ codec: 'aac', sampleRate: 48_000, channels: 2 })
  })

  it('ignores cover art and refuses playlists and other containers', () => {
    const mp3 = parseProbe(probeJson({ format_name: 'mp3', duration: '3.0' }, [
      { codec_type: 'audio', codec_name: 'mp3' },
      { codec_type: 'video', codec_name: 'mjpeg', width: 500, height: 500, disposition: { attached_pic: 1 } },
    ]))
    expect(mp3.video).toBeNull()
    expect(mp3.mimeType).toBe('audio/mpeg')
    expect(parseProbe(probeJson({ format_name: 'hls', duration: '10' }, [{ codec_type: 'video', width: 10, height: 10 }])).demuxer).toBeNull()
    expect(parseProbe(probeJson({ format_name: 'concat' }, [])).demuxer).toBeNull()
    expect(parseProbe(probeJson({ format_name: 'matroska,webm', duration: '1' }, [{ codec_type: 'video', codec_name: 'vp9', width: 2, height: 2 }])).mimeType).toBe('video/webm')
  })

  it('rejects unreadable output and odd rates', () => {
    expect(() => parseProbe('not json')).toThrow(MediaToolError)
    expect(parseRate('0/0')).toBeNull()
    expect(parseRate('25')).toBe(25)
  })
})

describe('share links → direct downloads', () => {
  it('converts Google Drive file links (keeping the resource key) and refuses folders and Docs', () => {
    expect(directDownloadUrl('google_drive', 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing&resourcekey=0-xyz')).toBe(
      'https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMnOp&export=download&confirm=t&resourcekey=0-xyz',
    )
    expect(directDownloadUrl('google_drive', 'https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp')).toContain('id=1AbCdEfGhIjKlMnOp')
    expect(() => directDownloadUrl('google_drive', 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp')).toThrow(DRIVE_MESSAGES.folder)
    expect(() => directDownloadUrl('google_drive', 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit')).toThrow(DRIVE_MESSAGES.googleDoc)
    expect(() => directDownloadUrl('google_drive', 'https://drive.google.com/file/d/x/view')).toThrow(IngestRefusal)
  })

  it('converts Dropbox links to dl=1 and refuses folders', () => {
    expect(directDownloadUrl('dropbox', 'https://www.dropbox.com/scl/fi/abc123/talk.mp4?rlkey=k1&dl=0')).toBe('https://www.dropbox.com/scl/fi/abc123/talk.mp4?rlkey=k1&dl=1')
    expect(directDownloadUrl('dropbox', 'https://dropbox.com/s/abc/talk.mp4?raw=1')).toBe('https://www.dropbox.com/s/abc/talk.mp4?dl=1')
    expect(() => directDownloadUrl('dropbox', 'https://www.dropbox.com/scl/fo/abc/xyz?dl=0')).toThrow(DRIVE_MESSAGES.folder)
  })

  it('uses the OneDrive shares API', () => {
    const url = directDownloadUrl('onedrive', 'https://1drv.ms/v/s!AbCd?e=x')
    expect(url).toMatch(/^https:\/\/api\.onedrive\.com\/v1\.0\/shares\/u![A-Za-z0-9_-]+\/root\/content$/)
    expect(url).not.toContain('=')
  })
})

describe('drive download', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'drive-dl-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const body = new Uint8Array(Buffer.from('fake video bytes '.repeat(100)))
  const base = { provider: 'google_drive' as const, maxBytes: 1_000_000, timeoutMs: 5_000, idleTimeoutMs: 5_000 }
  const scripted = (responses: Array<Response | Error>) => {
    const calls: string[] = []
    const fetch: FetchLike = async (url, init) => {
      calls.push(url)
      expect(init?.redirect).toBe('manual')
      const next = responses.shift()
      if (!next) throw new Error('unexpected fetch')
      if (next instanceof Error) throw next
      return next
    }
    return { fetch, calls }
  }

  it('follows allowed redirects, streams to disk and hashes', async () => {
    const { fetch, calls } = scripted([redirectResponse('https://doc-0s-1a-docs.googleusercontent.com/docs/file?x=1'), fileResponse(body)])
    const path = join(dir, 'ok.bin')
    const result = await downloadDriveFile('https://drive.usercontent.google.com/download?id=abcdefghijk&export=download', path, { ...base, fetch })
    expect(result.bytes).toBe(body.byteLength)
    expect(result.sha256).toBe((await hashFile(path)).sha256)
    expect(Buffer.from(await readFile(path)).equals(Buffer.from(body))).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('refuses a redirect to a host outside the provider (and never fetches it)', async () => {
    const { fetch, calls } = scripted([redirectResponse('https://evil.example.com/video.mp4')])
    await expect(downloadDriveFile('https://drive.usercontent.google.com/download?id=abcdefghijk', join(dir, 'x.bin'), { ...base, fetch })).rejects.toThrow(DRIVE_MESSAGES.badRedirect)
    expect(calls).toHaveLength(1)
  })

  it('refuses a redirect to YouTube with the own-content message', async () => {
    const { fetch } = scripted([redirectResponse('https://www.youtube.com/watch?v=abc')])
    await expect(downloadDriveFile('https://drive.usercontent.google.com/download?id=abcdefghijk', join(dir, 'y.bin'), { ...base, fetch })).rejects.toThrow(SOURCE_URL_MESSAGES.video_site_forbidden)
  })

  it('refuses http, endless redirects, web pages, private files and oversize bodies', async () => {
    const hop = (n: number) => redirectResponse(`https://drive.usercontent.google.com/download?id=abcdefghijk&n=${n}`)
    await expect(downloadDriveFile('http://drive.usercontent.google.com/x', join(dir, 'a'), { ...base, fetch: scripted([]).fetch })).rejects.toThrow(IngestRefusal)
    await expect(downloadDriveFile('https://drive.usercontent.google.com/download?id=abcdefghijk', join(dir, 'b'), { ...base, fetch: scripted([0, 1, 2, 3, 4, 5, 6].map(hop)).fetch })).rejects.toThrow(
      DRIVE_MESSAGES.tooManyRedirects,
    )
    await expect(downloadDriveFile('https://drive.usercontent.google.com/download?id=abcdefghijk', join(dir, 'c'), { ...base, fetch: scripted([fileResponse(body, 'text/html; charset=utf-8')]).fetch })).rejects.toThrow(
      DRIVE_MESSAGES.webPage,
    )
    await expect(downloadDriveFile('https://drive.usercontent.google.com/download?id=abcdefghijk', join(dir, 'd'), { ...base, fetch: scripted([new Response('no', { status: 403 })]).fetch })).rejects.toThrow(
      DRIVE_MESSAGES.private,
    )
    await expect(downloadDriveFile('https://drive.usercontent.google.com/download?id=abcdefghijk', join(dir, 'e'), { ...base, maxBytes: 100, fetch: scripted([fileResponse(body)]).fetch })).rejects.toThrow(
      DRIVE_MESSAGES.tooLarge,
    )
    // no content-length: the stream itself is capped
    const unsized = new Response(new Blob([Buffer.from(body)]).stream(), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    await expect(downloadDriveFile('https://drive.usercontent.google.com/download?id=abcdefghijk', join(dir, 'f'), { ...base, maxBytes: 100, fetch: scripted([unsized]).fetch })).rejects.toThrow(
      DRIVE_MESSAGES.tooLarge,
    )
  })

  it('treats 5xx, 429 and network errors as temporary', async () => {
    const url = 'https://drive.usercontent.google.com/download?id=abcdefghijk'
    await expect(downloadDriveFile(url, join(dir, 'g'), { ...base, fetch: scripted([new Response('busy', { status: 503 })]).fetch })).rejects.toBeInstanceOf(TransientDownloadError)
    await expect(downloadDriveFile(url, join(dir, 'h'), { ...base, fetch: scripted([new Response('slow', { status: 429 })]).fetch })).rejects.toBeInstanceOf(TransientDownloadError)
    await expect(downloadDriveFile(url, join(dir, 'i'), { ...base, fetch: scripted([new TypeError('fetch failed')]).fetch })).rejects.toBeInstanceOf(TransientDownloadError)
  })

  it('stops on job abort and on stalls', async () => {
    const url = 'https://drive.usercontent.google.com/download?id=abcdefghijk'
    const controller = new AbortController()
    controller.abort()
    await expect(downloadDriveFile(url, join(dir, 'j'), { ...base, signal: controller.signal, fetch: scripted([]).fetch })).rejects.toBeInstanceOf(JobAbortedError)
    const stalled: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    await expect(downloadDriveFile(url, join(dir, 'k'), { ...base, idleTimeoutMs: 50, fetch: stalled })).rejects.toThrow('took too long')
  })
})

describe('process runner', () => {
  it('runs tools without a shell and with a minimal environment', async () => {
    const out = await runTool('node', ['-e', 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), secret: process.env.DATABASE_URL ?? null }))', '$(touch /tmp/pwned)', '; rm -rf /'], {
      timeoutMs: 10_000,
      captureStdout: true,
    })
    expect(JSON.parse(out.stdout)).toEqual({ argv: ['$(touch /tmp/pwned)', '; rm -rf /'], secret: null })
    expect(toolEnv({ PATH: '/bin', DATABASE_URL: 'postgres://u:p@h/db', UPLOAD_POST_API_KEY: 'k' })).toEqual({ PATH: '/bin' })
  })

  it('reports exit codes, missing tools, timeouts and aborts', async () => {
    await expect(runTool('node', ['-e', 'process.exit(3)'], { timeoutMs: 10_000 })).rejects.toMatchObject({ reason: 'exit', exitCode: 3 })
    await expect(runTool('definitely-not-a-tool-xyz', [], { timeoutMs: 1_000 })).rejects.toMatchObject({ reason: 'spawn' })
    await expect(runTool('node', ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 100 })).rejects.toMatchObject({ reason: 'timeout' })
    const controller = new AbortController()
    const running = runTool('node', ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 10_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    await expect(running).rejects.toBeInstanceOf(JobAbortedError)
  })

  it('always removes the temp directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'withtmp-'))
    let inner = ''
    await expect(
      withTempDir(root, 'x', async (dir) => {
        inner = dir
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await expect(readFile(join(inner, 'nothing'))).rejects.toThrow()
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(root)).toEqual([])
    await rm(root, { recursive: true, force: true })
  })
})

describe('retry classification', () => {
  it('retries outages and refuses to retry permanent failures', () => {
    expect(isRetryableMediaError(new PermanentJobError('x'))).toBe(false)
    expect(isRetryableMediaError(new MediaToolError('x', 'exit', 'ffmpeg', 1, ''))).toBe(false)
    expect(isRetryableMediaError(new MediaToolError('x', 'timeout', 'ffmpeg', null, ''))).toBe(true)
    expect(isRetryableMediaError(new MediaToolError('x', 'spawn', 'ffmpeg', null, ''))).toBe(true)
    expect(isRetryableMediaError(transcriptionError('engine_unavailable', 'down'))).toBe(true)
    expect(isRetryableMediaError(transcriptionError('engine_failed', 'no speech'))).toBe(false)
    expect(isRetryableMediaError(new AppError('validation', 'bad'))).toBe(false)
    expect(isRetryableMediaError(new AppError('unavailable', 'db down'))).toBe(true)
    expect(isRetryableMediaError(new Error('connection reset'))).toBe(true)
  })
})

describe('templates', () => {
  const size = { width: 1080, height: 1350 }
  it('escapes text and never emits script', () => {
    const html = carouselSlideHtml(
      { heading: '<script>alert(1)</script>', body: 'a & b "c"', footer: '@acme' },
      { template: 'minimal', theme: resolveTheme(undefined), size, index: 0, total: 3 },
    )
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('1/3')
    expect(escapeHtml(`'`)).toBe('&#39;')
  })

  it('re-checks theme colours and picks readable text on the accent', () => {
    expect(resolveTheme({ background: 'red;}</style><script>', accent: '#000000', font: 'serif' })).toMatchObject({ background: '#ffffff', accent: '#000000', font: 'serif' })
    expect(contrastOn('#000000')).toBe('#ffffff')
    expect(contrastOn('#ffffff')).toBe('#111111')
  })

  it('inlines only allowed image types', () => {
    const ok = videoSlideHtml({ text: 'Hi', durationMs: 1000, imageMediaId: undefined }, {
      template: 'captioned_images',
      theme: resolveTheme(undefined),
      size: { width: 1080, height: 1920 },
      captions: true,
      image: { mimeType: 'image/png', base64: 'AAAA' },
    })
    expect(ok).toContain('data:image/png;base64,AAAA')
    expect(ok).toContain('class="caption"')
    const bad = videoSlideHtml({ text: 'Hi', durationMs: 1000 }, {
      template: 'text_slides',
      theme: resolveTheme(undefined),
      size: { width: 1080, height: 1920 },
      captions: true,
      image: { mimeType: 'image/svg+xml', base64: 'AAAA' },
    })
    expect(bad).not.toContain('data:image/svg')
  })
})
