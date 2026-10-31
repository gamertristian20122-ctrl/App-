import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

export async function tempAudio(name = 'audio.mp3', content: string | Buffer = 'ID3 fake mp3 bytes'): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'transcription-test-'))
  const path = join(dir, name)
  await writeFile(path, content)
  return { dir, path }
}

export type Responder = (url: string, init: RequestInit) => Response | Promise<Response>

export interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  init: RequestInit
}

/** A fetch mock that answers with the given responders in order and records every call. */
export function mockFetch(responders: Array<Responder | Response>) {
  const queue = [...responders]
  const calls: FetchCall[] = []
  const fn = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v
    })
    calls.push({ url: String(input), method: init.method ?? 'GET', headers, init })
    const next = queue.shift()
    if (!next) throw new Error(`unexpected fetch ${String(input)}`)
    return typeof next === 'function' ? next(String(input), init) : next
  })
  return { fetch: fn, calls, remaining: () => queue.length }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** Never answers; rejects when the request is aborted (timeouts, cancellation). */
export const hang: Responder = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init.signal
    if (signal?.aborted) reject(signal.reason)
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })

/** A virtual clock + sleep for polling tests (no real waiting). */
export function virtualTime(start = 1_000_000) {
  let now = start
  const sleeps: number[] = []
  return {
    now: () => now,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw signal.reason
      sleeps.push(ms)
      now += ms
    },
    sleeps,
    advance: (ms: number) => {
      now += ms
    },
  }
}

/** A typical OpenAI-style verbose_json response. */
export const WHISPER_VERBOSE = {
  task: 'transcribe',
  language: 'english',
  duration: 4.25,
  text: ' Hello world. This is a test.',
  words: [
    { word: ' Hello', start: 0.0, end: 0.42 },
    { word: ' world.', start: 0.42, end: 0.9 },
    { word: ' This', start: 1.5, end: 1.7 },
    { word: ' is', start: 1.7, end: 1.82 },
    { word: ' a', start: 1.82, end: 1.9 },
    { word: ' test.', start: 1.9, end: 2.4 },
  ],
  segments: [
    { id: 0, seek: 0, start: 0.0, end: 0.9, text: ' Hello world.', tokens: [1, 2], temperature: 0, avg_logprob: -0.2, compression_ratio: 1.1, no_speech_prob: 0.01 },
    { id: 1, seek: 0, start: 1.5, end: 2.4, text: ' This is a test.', tokens: [3, 4], temperature: 0, avg_logprob: -0.2, compression_ratio: 1.1, no_speech_prob: 0.01 },
  ],
}

export const ASSEMBLY_COMPLETED = {
  id: 'tr_abc123',
  status: 'completed',
  text: 'Hello world. This is a test.',
  language_code: 'en_us',
  audio_duration: 3,
  words: [
    { text: 'Hello', start: 100, end: 420, confidence: 0.99 },
    { text: 'world.', start: 420, end: 900, confidence: 0.98 },
    { text: 'This', start: 1500, end: 1700, confidence: 0.97 },
    { text: 'is', start: 1700, end: 1820, confidence: 0.97 },
    { text: 'a', start: 1820, end: 1900, confidence: 0.96 },
    { text: 'test.', start: 1900, end: 3400, confidence: 0.95 },
  ],
}
