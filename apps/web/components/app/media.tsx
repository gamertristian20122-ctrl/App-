// Media library: browser uploads, cloud-drive links for clip sources, and the list of files.

import Link from 'next/link'
import { DRIVE_HOSTS, SOURCE_URL_MESSAGES } from '@app/core/links'
import { ActionForm, SubmitButton, type FormAction } from '@/components/ui/action-form'
import { Badge, Card, EmptyState, LinkButton, PageHeader, StatusPill } from '@/components/ui/primitives'
import { link } from '@/components/ui/styles'
import type { MediaItem } from '@/lib/ui/data'
import { formatBytes, formatDate, formatDuration } from '@/lib/ui/format'
import { withQuery } from '@/lib/ui/paths'
import { DriveLinkForm } from './drive-link-form'
import { MediaUploader } from './media-uploader'

export interface MediaActions {
  addDriveLink: FormAction
  remove: FormAction
}

const KIND_LABEL: Record<string, string> = { video: 'Video', image: 'Image', audio: 'Audio', captions: 'Captions' }
const ORIGIN_LABEL: Record<string, string> = { upload: 'Uploaded', drive_link: 'Cloud drive', clip: 'Clip', render: 'Rendered' }
const PROVIDER_LABEL: Record<string, string> = { google_drive: 'Google Drive', dropbox: 'Dropbox', onedrive: 'OneDrive' }

function KindIcon({ kind }: { kind: string }) {
  const d =
    kind === 'video'
      ? 'M4 6h11v12H4zM15 10l5-3v10l-5-3'
      : kind === 'audio'
        ? 'M9 18V6l10-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm10-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'
        : 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5'
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

export function MediaList({ items, actions, nextCursor }: { items: MediaItem[]; actions: MediaActions; nextCursor: string | null }) {
  if (items.length === 0) {
    return <EmptyState title="No media yet">Upload a video above, or add a link from your cloud drive.</EmptyState>
  }
  return (
    <>
      <ul className="divide-y divide-neutral-200 dark:divide-neutral-800" aria-label="Media">
        {items.map(({ media, thumbUrl, clipSource }) => (
          <li key={media.id} className="flex flex-wrap items-center gap-4 py-3">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-neutral-100 text-neutral-500 dark:bg-neutral-800">
              {thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumbUrl} alt="" referrerPolicy="no-referrer" loading="lazy" className="h-full w-full object-cover" />
              ) : (
                <KindIcon kind={media.kind} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {KIND_LABEL[media.kind] ?? media.kind}
                <StatusPill status={media.status === 'pending' ? 'processing' : media.status} />
                {clipSource ? <Badge tone="info">Clip source</Badge> : null}
              </p>
              <p className="text-xs text-neutral-500">
                {ORIGIN_LABEL[media.origin] ?? media.origin}
                {media.sourceHost ? ` (${media.sourceHost})` : ''} · {formatDate(media.createdAt)}
                {media.durationMs ? ` · ${formatDuration(media.durationMs)}` : ''}
                {media.bytes ? ` · ${formatBytes(media.bytes)}` : ''}
                {media.width && media.height ? ` · ${media.width}×${media.height}` : ''}
              </p>
              <p className="text-xs text-neutral-500">
                Media id (for your AI assistant): <code className="select-all break-all font-mono">{media.id}</code>
              </p>
            </div>
            <div className="flex items-center gap-2">
              {clipSource && media.status !== 'failed' ? (
                <Link href={`/app/clips?source=${media.id}`} className={`${link} text-sm`}>
                  Transcript & clips
                </Link>
              ) : null}
              <ActionForm action={actions.remove} confirm="Delete this file? Drafts that use it can no longer be published.">
                <input type="hidden" name="mediaId" value={media.id} />
                <SubmitButton variant="ghost" className="px-2 py-1 text-xs" pendingLabel="Deleting…">
                  Delete
                </SubmitButton>
              </ActionForm>
            </div>
          </li>
        ))}
      </ul>
      {nextCursor ? (
        <div className="mt-4 text-center">
          <LinkButton href={withQuery('/app/media', { cursor: nextCursor })}>Older files</LinkButton>
        </div>
      ) : null}
    </>
  )
}

export function MediaView({
  items,
  nextCursor,
  brands,
  defaultBrandId,
  actions,
}: {
  items: MediaItem[]
  nextCursor: string | null
  brands: Array<{ id: string; name: string }>
  defaultBrandId: string | null
  actions: MediaActions
}) {
  return (
    <>
      <PageHeader
        title="Media"
        description="Upload long videos to clip into shorts, and images or finished videos to attach to posts. Only use content you own or have the rights to."
      />
      <div className="space-y-6">
        <div className="grid gap-6 xl:grid-cols-2">
          <Card title="Upload a file">
            <MediaUploader brands={brands} defaultBrandId={defaultBrandId} />
          </Card>
          <Card title="Add from a cloud drive" description="For long videos already in your drive. We download the file you share; nothing else.">
            <DriveLinkForm action={actions.addDriveLink} brands={brands} defaultBrandId={defaultBrandId} />
            <div className="mt-5 rounded-lg bg-neutral-50 p-3 text-xs text-neutral-600 dark:bg-neutral-950 dark:text-neutral-400">
              <p className="font-medium text-neutral-800 dark:text-neutral-200">Supported links</p>
              <ul className="mt-1 space-y-0.5" aria-label="Allowed hosts">
                {Object.entries(DRIVE_HOSTS).map(([provider, hosts]) => (
                  <li key={provider}>
                    {PROVIDER_LABEL[provider] ?? provider}: {hosts.join(', ')}
                  </li>
                ))}
              </ul>
              <p className="mt-2" data-testid="youtube-refusal">
                {SOURCE_URL_MESSAGES.video_site_forbidden}
              </p>
            </div>
          </Card>
        </div>
        <Card title="Your files">
          <MediaList items={items} actions={actions} nextCursor={nextCursor} />
        </Card>
      </div>
    </>
  )
}
