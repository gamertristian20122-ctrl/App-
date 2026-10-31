'use client'

// Upload form: a file, what it is for (post media or a clip source), an optional brand and, for
// clip sources, the required "I own this content" confirmation. Shows progress, then refreshes
// the list.

import { useRouter } from 'next/navigation'
import { useId, useState, type FormEvent } from 'react'
import { button, cx, hint, input, label } from '@/components/ui/styles'
import { showToast } from '@/components/ui/toaster'
import { formatBytes } from '@/lib/ui/format'
import { UPLOAD_ACCEPT, UploadError, uploadFile, xhrPut, type UploadPurpose } from '@/lib/ui/upload'

export function MediaUploader({ brands, defaultBrandId }: { brands: Array<{ id: string; name: string }>; defaultBrandId: string | null }) {
  const router = useRouter()
  const uid = useId()
  const [purpose, setPurpose] = useState<UploadPurpose>('clip_source')
  const [file, setFile] = useState<File | null>(null)
  const [rights, setRights] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = progress !== null

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file || busy) return
    setError(null)
    const formEl = event.currentTarget
    const form = new FormData(formEl)
    const brandId = typeof form.get('brandId') === 'string' ? String(form.get('brandId')) : ''
    setProgress(0)
    try {
      const result = await uploadFile(
        { file, purpose, brandId: brandId || null, rightsAttested: rights },
        { fetch: (u, init) => fetch(u, init), put: xhrPut },
        (f) => setProgress(f),
      )
      showToast({
        tone: 'success',
        message: result.ingestQueued ? 'Uploaded. We are processing the file; it is ready in a minute or two.' : 'Uploaded.',
      })
      setFile(null)
      setRights(false)
      formEl.reset()
      router.refresh()
    } catch (err) {
      const message = err instanceof UploadError ? err.message : 'The upload failed. Check your connection and try again.'
      setError(message)
      showToast({ tone: 'error', message })
    } finally {
      setProgress(null)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" aria-label="Upload a file">
      <fieldset>
        <legend className={label}>What is it for?</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {(
            [
              { value: 'clip_source', title: 'A long video to clip', body: 'Podcast, stream or talk. Uses clipping hours.' },
              { value: 'post', title: 'Media for a post', body: 'An image or a finished video to attach.' },
            ] as const
          ).map((o) => (
            <label
              key={o.value}
              className={cx(
                'flex cursor-pointer gap-3 rounded-lg border p-3 text-sm',
                purpose === o.value ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950' : 'border-neutral-300 dark:border-neutral-700',
              )}
            >
              <input type="radio" name="purpose" value={o.value} checked={purpose === o.value} onChange={() => setPurpose(o.value)} className="mt-0.5" />
              <span>
                <span className="block font-medium">{o.title}</span>
                <span className="text-neutral-600 dark:text-neutral-400">{o.body}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${uid}-file`} className={label}>
            File
          </label>
          <input
            id={`${uid}-file`}
            type="file"
            required
            accept={purpose === 'clip_source' ? 'video/*' : UPLOAD_ACCEPT}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="mt-1 block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-100 file:px-3 file:py-2 file:text-sm file:font-medium dark:file:bg-neutral-800"
          />
          {file ? <p className={hint}>{formatBytes(file.size)}</p> : <p className={hint}>Videos up to 10 GB and 4 hours.</p>}
        </div>
        <div>
          <label htmlFor={`${uid}-brand`} className={label}>
            Brand
          </label>
          <select id={`${uid}-brand`} name="brandId" defaultValue={defaultBrandId ?? ''} className={cx(input, 'mt-1')}>
            <option value="">No brand</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} required={purpose === 'clip_source'} className="mt-0.5 h-4 w-4" />
        <span>
          I own this content or have the rights to use it.
          {purpose === 'clip_source' ? <span className="text-neutral-500"> (Required for videos you clip.)</span> : null}
        </span>
      </label>

      {progress !== null ? (
        <div>
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className="h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
          >
            <div className="h-full bg-indigo-600 transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="mt-1 text-xs text-neutral-500">Uploading… {Math.round(progress * 100)}%</p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}

      <button type="submit" disabled={!file || busy || (purpose === 'clip_source' && !rights)} className={button.primary}>
        {busy ? 'Uploading…' : 'Upload'}
      </button>
    </form>
  )
}
