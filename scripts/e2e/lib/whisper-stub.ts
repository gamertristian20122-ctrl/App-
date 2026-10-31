// A tiny OpenAI-compatible Whisper server (POST /v1/audio/transcriptions → canned verbose_json),
// used with `--whisper` so the worker's real Whisper adapter (multipart upload of the extracted
// audio, verbose_json parsing) runs instead of the fake transcriber.

import { createServer } from 'node:http'

const SENTENCES = [
  'Here is the one mistake almost every creator makes.',
  'You film a long video and you post it exactly once.',
  'Cut it into short clips, each with its own hook.',
  'The first three seconds decide everything.',
]

/** verbose_json for a source of `durationSec`, words spread evenly from 0.5 s. */
export function cannedTranscript(durationSec: number) {
  const words = SENTENCES.join(' ').split(/\s+/)
  const span = Math.max(1, durationSec - 1)
  const per = span / words.length
  const timed = words.map((word, i) => ({ word, start: +(0.5 + i * per).toFixed(2), end: +(0.5 + i * per + per * 0.8).toFixed(2) }))
  const segments: Array<{ start: number; end: number; text: string }> = []
  let i = 0
  for (const sentence of SENTENCES) {
    const n = sentence.split(/\s+/).length
    const slice = timed.slice(i, i + n)
    i += n
    const first = slice[0]
    const last = slice[slice.length - 1]
    if (first && last) segments.push({ start: first.start, end: last.end, text: ` ${sentence}` })
  }
  return { task: 'transcribe', language: 'english', duration: durationSec, text: SENTENCES.join(' '), words: timed, segments }
}

export interface WhisperStub {
  url: string
  requests: number
  close(): Promise<void>
}

export function startWhisperStub(port: number, durationSec: number): Promise<WhisperStub> {
  const stub = { url: `http://127.0.0.1:${port}/v1`, requests: 0, close: async () => undefined } as WhisperStub
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/audio/transcriptions')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"not found"}}')
      return
    }
    // drain the multipart body (the audio file); we only check that something was sent
    let bytes = 0
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
    })
    req.on('end', () => {
      stub.requests++
      if (bytes < 100) {
        res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"message":"no audio"}}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(cannedTranscript(durationSec)))
    })
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      stub.close = () => new Promise((r) => server.close(() => r()))
      resolve(stub)
    })
  })
}
