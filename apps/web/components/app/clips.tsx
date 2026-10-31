// Clips: source videos → transcript viewer (search) → clips and their status. A manual "make a
// clip" form complements the AI's pick_clips / make_clips flow.

import Link from 'next/link'
import { CAPTION_STYLES } from '@app/core/validation'
import { ActionForm, SubmitButton, type FormAction } from '@/components/ui/action-form'
import { Card, EmptyState, LinkButton, Notice, PageHeader, StatusPill } from '@/components/ui/primitives'
import { button, cx, input, label, link } from '@/components/ui/styles'
import type { ClipsData } from '@/lib/ui/data'
import { formatDate, formatDuration, formatTimestamp, plural } from '@/lib/ui/format'

const CAPTION_LABELS: Record<string, string> = { bold: 'Bold', minimal: 'Minimal', karaoke: 'Karaoke (word by word)', none: 'No captions' }

function TranscriptPanel({ data }: { data: ClipsData }) {
  const t = data.transcript
  const source = data.selected
  if (!source) return null
  if (!t) return <Notice tone="warning">The transcript could not be loaded.</Notice>
  if (t.status !== 'ready') {
    return (
      <Notice tone={t.status === 'failed' ? 'danger' : 'info'} title={t.status === 'failed' ? 'Transcription failed' : 'Transcribing…'}>
        {t.message ?? (t.status === 'processing' ? 'This usually takes a few minutes. Refresh to check.' : null)}
      </Notice>
    )
  }
  const rows = data.query ? (t.matches ?? []).map((m) => ({ s: m.startMs, e: m.endMs, t: m.text })) : t.segments
  return (
    <div>
      <form method="get" action="/app/clips" className="flex gap-2" role="search">
        <input type="hidden" name="source" value={source.id} />
        <label htmlFor="q" className="sr-only">
          Search the transcript
        </label>
        <input id="q" name="q" type="search" defaultValue={data.query ?? ''} maxLength={200} placeholder="Search the transcript" className={input} />
        <button type="submit" className={button.secondary}>
          Search
        </button>
      </form>
      <p className="mt-2 text-xs text-neutral-500">
        {data.query ? `${plural(rows.length, 'match', 'matches')} for “${data.query}”. ` : `${plural(rows.length, 'segment')}. `}
        {t.language ? `Language: ${t.language}.` : ''}
        {data.query ? (
          <>
            {' '}
            <Link href={`/app/clips?source=${source.id}`} className={link}>
              Clear search
            </Link>
          </>
        ) : null}
      </p>
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-500">{data.query ? 'No matches.' : 'The transcript is empty.'}</p>
      ) : (
        <ol className="mt-3 max-h-[28rem] space-y-1 overflow-y-auto rounded-lg border border-neutral-200 p-2 text-sm dark:border-neutral-800" aria-label="Transcript">
          {rows.map((seg, i) => (
            <li key={`${seg.s}-${i}`} className="grid grid-cols-[4.5rem_1fr] gap-2 rounded px-2 py-1 hover:bg-neutral-50 dark:hover:bg-neutral-800">
              <span className="font-mono text-xs leading-5 text-neutral-500 tabular-nums">{formatTimestamp(seg.s)}</span>
              <span>{seg.t}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export function ClipsView({ data, requestClip }: { data: ClipsData; requestClip: FormAction }) {
  if (data.sources.length === 0) {
    return (
      <>
        <PageHeader title="Clips" />
        <EmptyState title="No videos to clip yet" action={<LinkButton href="/app/media" variant="primary">Upload a video</LinkButton>}>
          Upload a long video (or add a cloud-drive link) and confirm you own it. We transcribe it so your AI can pick the best moments.
        </EmptyState>
      </>
    )
  }
  const source = data.selected
  return (
    <>
      <PageHeader
        title="Clips"
        description="Read a video's transcript and follow its clips. Ask your AI to “pick the best clips” from a video, or make one yourself."
      />
      <div className="grid gap-6 xl:grid-cols-[18rem_1fr]">
        <Card title="Source videos" as="section">
          <ul className="space-y-1" aria-label="Source videos">
            {data.sources.map((m) => (
              <li key={m.id}>
                <Link
                  href={`/app/clips?source=${m.id}`}
                  aria-current={source?.id === m.id ? 'true' : undefined}
                  className={cx(
                    'block rounded-lg px-3 py-2 text-sm',
                    source?.id === m.id ? 'bg-indigo-50 dark:bg-indigo-950' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800',
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium">{m.sourceHost ?? 'Uploaded video'}</span>
                    <StatusPill status={m.status === 'pending' ? 'processing' : m.status} />
                  </span>
                  <span className="text-xs text-neutral-500">
                    {formatDate(m.createdAt)}
                    {m.durationMs ? ` · ${formatDuration(m.durationMs)}` : ''}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        {source ? (
          <div className="min-w-0 space-y-6">
            <Card title="Transcript" description={source.durationMs ? `Length ${formatDuration(source.durationMs)}` : undefined}>
              <TranscriptPanel data={data} />
            </Card>

            <Card title="Make a clip" description="3 seconds to 3 minutes. Vertical 9:16 with burned-in captions. Clipping time is charged once per source video.">
              <ActionForm action={requestClip} resetOnSuccess className="grid gap-4 sm:grid-cols-2" aria-label="Make a clip">
                <input type="hidden" name="mediaId" value={source.id} />
                {source.brandId ? <input type="hidden" name="brandId" value={source.brandId} /> : null}
                <div>
                  <label htmlFor="clip-start" className={label}>
                    Start
                  </label>
                  <input id="clip-start" name="start" required placeholder="1:02.5" maxLength={20} className={cx(input, 'mt-1')} />
                </div>
                <div>
                  <label htmlFor="clip-end" className={label}>
                    End
                  </label>
                  <input id="clip-end" name="end" required placeholder="1:45" maxLength={20} className={cx(input, 'mt-1')} />
                </div>
                <div>
                  <label htmlFor="clip-title" className={label}>
                    Title (optional)
                  </label>
                  <input id="clip-title" name="title" maxLength={100} className={cx(input, 'mt-1')} />
                </div>
                <div>
                  <label htmlFor="clip-style" className={label}>
                    Captions
                  </label>
                  <select id="clip-style" name="captionStyle" defaultValue="bold" className={cx(input, 'mt-1')}>
                    {CAPTION_STYLES.map((s) => (
                      <option key={s} value={s}>
                        {CAPTION_LABELS[s] ?? s}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <SubmitButton disabled={source.status !== 'ready'} pendingLabel="Queuing…">
                    Make clip
                  </SubmitButton>
                  {source.status !== 'ready' ? <p className="mt-1 text-xs text-neutral-500">Available when the video is ready.</p> : null}
                </div>
              </ActionForm>
            </Card>

            <Card title="Clips from this video">
              {data.clips.length === 0 ? (
                <EmptyState title="No clips yet">Ask your AI to pick clips from this video, or make one above.</EmptyState>
              ) : (
                <ul className="divide-y divide-neutral-200 dark:divide-neutral-800" aria-label="Clips">
                  {data.clips.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{c.title ?? 'Untitled clip'}</p>
                        <p className="font-mono text-xs text-neutral-500 tabular-nums">
                          {formatTimestamp(c.startMs)} – {formatTimestamp(c.endMs)} ({formatDuration(c.endMs - c.startMs)})
                        </p>
                        {c.hook ? <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">Hook: {c.hook}</p> : null}
                        {c.status === 'failed' && c.error ? <p className="mt-1 text-xs text-red-700 dark:text-red-300">{c.error}</p> : null}
                      </div>
                      <div className="flex items-center gap-3">
                        <StatusPill status={c.status} />
                        {c.draftId ? (
                          <Link href={`/app/approvals?draft=${c.draftId}`} className={`${link} text-sm`}>
                            Review draft
                          </Link>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        ) : null}
      </div>
    </>
  )
}
