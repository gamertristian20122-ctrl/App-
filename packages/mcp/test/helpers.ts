// Test harness: real services on PGlite (real migrations) with the fake posting provider, memory
// storage and a manual clock; MCP clients connected to createMcpServer over the SDK's in-memory
// transport. Nothing touches the network.

import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { expect } from 'vitest'
import { memoryLogger, type MemoryLogger } from '@app/core/testing'
import { manualClock, type ManualClock } from '@app/core/time'
import type { Platform } from '@app/core/types'
import { bindRepos, type BoundRepos, type Db } from '@app/db'
import { createTestAccount, createTestBrand, createTestDb, createTestUser, resetTestDb, type TestUserOptions } from '@app/db/testing'
import { FakePostingProvider } from '@app/posting'
import { MemoryStorage } from '@app/storage'
import { createServices, type Services } from '@app/services'
import { createMcpServer, type McpContext } from '../src'

export const START = new Date('2026-11-02T12:00:00.000Z')
export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const BASE_URL = 'https://app.test'
export const OTHER_UUID = '99999999-9999-4999-8999-999999999999'

export interface Harness {
  db: Db
  r: BoundRepos
  clock: ManualClock
  provider: FakePostingProvider
  storage: MemoryStorage
  services: Services
}

export async function createHarness(): Promise<Harness> {
  const db = await createTestDb()
  const clock = manualClock(START)
  const provider = new FakePostingProvider({ clock })
  const storage = new MemoryStorage()
  const services = createServices({ db, provider, storage, clock, config: { appUrl: BASE_URL } })
  return { db, r: bindRepos(db), clock, provider, storage, services }
}

export async function resetHarness(h: Harness): Promise<void> {
  await resetTestDb(h.db)
  h.clock.set(START)
  h.provider.reset()
}

export function ctxFor(h: Harness, userId: string, extra: Partial<McpContext> = {}): McpContext & { log: MemoryLogger } {
  return { services: h.services, userId, baseUrl: BASE_URL, log: memoryLogger('debug'), ...extra } as McpContext & { log: MemoryLogger }
}

export interface Connected {
  client: Client
  ctx: McpContext & { log: MemoryLogger }
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>
  close(): Promise<void>
}

/** An MCP client talking to createMcpServer(ctx) in memory (full initialize handshake). */
export async function connect(h: Harness, userId: string, extra: Partial<McpContext> = {}): Promise<Connected> {
  const ctx = ctxFor(h, userId, extra)
  const server = createMcpServer(ctx)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  return {
    client,
    ctx,
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

/** A user (starter, active) with one active brand and, optionally, connected accounts. */
export async function tenant(h: Harness, options: TestUserOptions & { platforms?: Platform[]; brandName?: string } = {}) {
  const user = await createTestUser(h.db, options)
  const brand = await createTestBrand(h.db, user.id, { name: options.brandName ?? 'Acme' })
  const accounts = []
  for (const platform of options.platforms ?? ['instagram']) accounts.push(await createTestAccount(h.db, user.id, brand.id, { platform, handle: `acme_${platform}` }))
  return { user, brand, accounts, userId: user.id, brandId: brand.id }
}

/** A ready uploaded image owned by the user. */
export async function image(h: Harness, userId: string, brandId: string | null = null) {
  return h.r.media.create(userId, {
    brandId,
    kind: 'image',
    origin: 'upload',
    status: 'ready',
    storageKey: `users/${userId}/uploads/${randomUUID()}.jpg`,
    mimeType: 'image/jpeg',
    bytes: 200_000,
    width: 1080,
    height: 1350,
  })
}

/** A transcribed 10-minute clip source (drive link → ingest → transcript). */
export async function transcribedSource(h: Harness, userId: string, brandId: string | null) {
  const { media } = await h.services.media.registerDriveLink(userId, {
    ...(brandId ? { brandId } : {}),
    url: 'https://drive.google.com/file/d/xyz/view',
    rightsAttested: true,
  })
  await h.services.media.markIngested(userId, media.id, { durationMs: 600_000, width: 1920, height: 1080 })
  const segments = [
    { s: 0, e: 30_000, t: 'The first segment talks about pricing.' },
    { s: 30_000, e: 60_000, t: 'Here is the hook nobody expects.' },
    { s: 60_000, e: 600_000, t: 'The rest of the talk.' },
  ]
  const words = segments.flatMap((seg) => {
    const parts = seg.t.split(' ')
    const step = Math.floor((seg.e - seg.s) / parts.length)
    return parts.map((t, i) => ({ s: seg.s + i * step, e: seg.s + (i + 1) * step, t }))
  })
  await h.services.transcripts.save(userId, media.id, {
    engine: 'fake',
    result: { language: 'en', durationMs: 600_000, text: segments.map((s) => s.t).join(' '), words, segments },
  })
  return media
}

/** Creates a draft through the service and approves it with a card nonce (as the card would). */
export async function approvedDraft(h: Harness, userId: string, brandId: string, variants: unknown[]) {
  const view = await h.services.drafts.create(userId, { brandId, variants })
  const nonce = await h.services.approvals.issueNonce(userId, view.draft.id)
  return h.services.approvals.approve(userId, { draftId: view.draft.id, nonce: nonce.nonce })
}

export function text(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

export function structured<T = Record<string, unknown>>(result: CallToolResult): T {
  return result.structuredContent as T
}

/** Asserts a tool error with `code` and returns its text. */
export function expectToolError(result: CallToolResult, code: string, message?: RegExp): string {
  expect(result.isError, `expected a tool error, got: ${text(result)}`).toBe(true)
  const error = (result.structuredContent as { error?: { code?: string } } | undefined)?.error
  expect(error?.code, text(result)).toBe(code)
  const t = text(result)
  if (message) expect(t).toMatch(message)
  return t
}

export function expectOk(result: CallToolResult): string {
  expect(result.isError ?? false, text(result)).toBe(false)
  return text(result)
}
