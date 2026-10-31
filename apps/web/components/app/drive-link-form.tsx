'use client'

// Cloud-drive link form for clip sources. Checks the link as you type with the same rules the
// server applies (checkSourceUrl: Google Drive, Dropbox, OneDrive only; YouTube and other video
// sites refused), then registers it through a server action.

import { useState } from 'react'
import { checkSourceUrl } from '@app/core/links'
import { ActionForm, SubmitButton, type FormAction } from '@/components/ui/action-form'
import { cx, hint, input, label } from '@/components/ui/styles'

export function DriveLinkForm({ action, brands, defaultBrandId }: { action: FormAction; brands: Array<{ id: string; name: string }>; defaultBrandId: string | null }) {
  const [url, setUrl] = useState('')
  const check = url.trim() ? checkSourceUrl(url) : null
  const problem = check && !check.ok ? check.message : null
  return (
    <ActionForm action={action} resetOnSuccess inline className="space-y-4" aria-label="Add a cloud-drive link">
      <div>
        <label htmlFor="drive-url" className={label}>
          Share link
        </label>
        <input
          id="drive-url"
          name="url"
          type="url"
          inputMode="url"
          required
          maxLength={2048}
          placeholder="https://drive.google.com/file/d/…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-invalid={problem ? true : undefined}
          aria-describedby="drive-url-help"
          className={cx(input, 'mt-1', problem && 'border-red-500 dark:border-red-500')}
        />
        <p id="drive-url-help" className={cx(hint, problem && 'text-red-700 dark:text-red-300')} aria-live="polite">
          {problem ?? 'Set the file to “anyone with the link can view”.'}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="drive-brand" className={label}>
            Brand
          </label>
          <select id="drive-brand" name="brandId" defaultValue={defaultBrandId ?? ''} className={cx(input, 'mt-1')}>
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
        <input type="checkbox" name="rightsAttested" required className="mt-0.5 h-4 w-4" />
        <span>I own this video or have the rights to use it.</span>
      </label>
      <SubmitButton disabled={Boolean(problem)} pendingLabel="Adding…">
        Add link
      </SubmitButton>
    </ActionForm>
  )
}
