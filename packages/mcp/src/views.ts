// What the model sees of our rows: the fields it needs to act, nothing internal (no storage keys,
// provider request ids, user ids, content hashes or credentials).

import type { ValidationIssue } from '@app/core/platforms'
import type { DraftPreview, DraftSummary, DraftView, JobView, MediaView, Services, VariantView } from '@app/services'
import { isClipSource } from '@app/services'

// Row types come through @app/services (@app/mcp depends on core + services only, not on @app/db).
type Row<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>
export type BrandRow = Row<Services['brands']['get']>
export type AccountRow = Row<Services['accounts']['get']>
export type PostRow = Row<Services['posts']['get']>
export type ClipRow = Row<Services['clips']['get']>
export type DraftRow = DraftView['draft']
export type VariantRow = DraftSummary['variants'][number]

export function brandView(b: BrandRow) {
  return { id: b.id, name: b.name, timezone: b.timezone, status: b.status }
}

export function accountView(a: AccountRow) {
  return {
    id: a.id,
    brandId: a.brandId,
    platform: a.platform,
    handle: a.handle,
    displayName: a.displayName,
    status: a.status,
    connectedAt: a.connectedAt,
  }
}

export function issueView(i: ValidationIssue) {
  return {
    field: i.field,
    severity: i.severity,
    message: i.message,
    ...(i.limit !== undefined ? { limit: i.limit } : {}),
    ...(i.actual !== undefined ? { actual: i.actual } : {}),
  }
}

function draftRowView(d: DraftRow) {
  return {
    id: d.id,
    brandId: d.brandId,
    status: d.status,
    revision: d.revision,
    approvedRevision: d.approvedRevision,
    approvedAt: d.approvedAt,
    rejectedReason: d.rejectedReason,
    notes: d.notes,
    sourceClipId: d.sourceClipId,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}

function variantRowView(v: VariantRow) {
  return {
    platform: v.platform,
    text: v.text,
    title: v.title,
    mediaIds: v.mediaIds,
    options: v.options,
    connectedAccountId: v.connectedAccountId,
    hasLink: v.hasLink,
  }
}

function variantView(v: VariantView) {
  return {
    ...variantRowView(v),
    ready: v.ready,
    account: v.account,
    issues: v.issues.map(issueView),
  }
}

export function draftView(view: DraftView) {
  return {
    ...draftRowView(view.draft),
    ready: view.ready,
    problems: view.problems,
    variants: view.variants.map(variantView),
  }
}

export function draftSummaryView(item: DraftSummary) {
  return { ...draftRowView(item.draft), variants: item.variants.map(variantRowView) }
}

export function draftRowOnlyView(d: DraftRow) {
  return draftRowView(d)
}

/** The approval card's data (also the model-visible structuredContent of approve_draft). */
export function previewView(p: DraftPreview) {
  return {
    draft: draftRowView(p.draft),
    brand: p.brand,
    ready: p.ready,
    problems: p.problems,
    variants: p.variants.map((v) => ({
      platform: v.platform,
      label: v.label,
      text: v.text,
      title: v.title,
      options: v.options,
      optionLines: v.optionLines,
      account: v.account,
      ready: v.ready,
      length: v.length,
      issues: v.issues.map(issueView),
      media: v.media.map((m) => ({
        id: m.id,
        kind: m.kind,
        mimeType: m.mimeType,
        width: m.width,
        height: m.height,
        durationMs: m.durationMs,
        status: m.status,
        url: m.url,
      })),
    })),
  }
}

export function postView(p: PostRow) {
  return {
    id: p.id,
    draftId: p.draftId,
    brandId: p.brandId,
    platform: p.platform,
    status: p.status,
    scheduledFor: p.scheduledFor,
    publishedAt: p.publishedAt,
    canceledAt: p.canceledAt,
    postUrl: p.postUrl,
    error: p.error,
    attempts: p.attempts,
    connectedAccountId: p.connectedAccountId,
  }
}

export function clipView(c: ClipRow) {
  return {
    id: c.id,
    brandId: c.brandId,
    sourceMediaId: c.sourceMediaId,
    startMs: c.startMs,
    endMs: c.endMs,
    title: c.title,
    hook: c.hook,
    captionStyle: c.captionStyle,
    status: c.status,
    outputMediaId: c.outputMediaId,
    draftId: c.draftId,
    error: c.error,
  }
}

export function jobViewForModel(j: JobView) {
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    runAt: j.runAt,
    finishedAt: j.finishedAt,
    error: j.error,
    result: j.result,
  }
}

export function mediaViewForModel(m: MediaView) {
  return {
    id: m.id,
    brandId: m.brandId,
    kind: m.kind,
    origin: m.origin,
    status: m.status,
    mimeType: m.mimeType,
    durationMs: m.durationMs,
    width: m.width,
    height: m.height,
    clipSource: isClipSource(m),
    createdAt: m.createdAt,
  }
}
