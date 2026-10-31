// Brands: create (within the plan's limit), rename / change time zone, archive and restore.

import { ActionForm, SubmitButton, type FormAction } from '@/components/ui/action-form'
import { Card, LinkButton, Meter, Notice, PageHeader, StatusPill } from '@/components/ui/primitives'
import { cx, input, label } from '@/components/ui/styles'
import type { BrandsData } from '@/lib/ui/data'
import { formatDate, plural } from '@/lib/ui/format'
import { timeZoneOptions } from '@/lib/ui/time'
import { TimeZoneSelect } from './time-zone-select'

export interface BrandActions {
  create: FormAction
  update: FormAction
  archive: FormAction
  restore: FormAction
}

function ZoneSelect({ id, defaultValue }: { id: string; defaultValue: string }) {
  return (
    <select id={id} name="timezone" defaultValue={defaultValue} className={cx(input, 'mt-1')}>
      {timeZoneOptions(defaultValue).map((z) => (
        <option key={z} value={z}>
          {z.replace(/_/g, ' ')}
        </option>
      ))}
    </select>
  )
}

export function BrandsView({ data, actions }: { data: BrandsData; actions: BrandActions }) {
  const atLimit = data.activeCount >= data.limit
  const canCreate = data.entitlements.canCreate
  return (
    <>
      <PageHeader
        title="Brands"
        description="A brand is one identity you post as: its own social accounts, voice profile and calendar."
      />
      <div className="space-y-6">
        <Card title="Your plan">
          <Meter
            label="Active brands"
            kind="slots"
            used={data.activeCount}
            limit={data.limit}
            display={`${data.activeCount} of ${data.limit}`}
            hint={data.entitlements.trial ? 'The free trial includes 1 brand.' : 'Extra brands are $3/month each.'}
          />
          {atLimit && canCreate ? (
            <Notice
              tone="info"
              className="mt-4"
              action={<LinkButton href="/app/billing">{data.entitlements.trial ? 'Choose a plan' : 'Add a brand'}</LinkButton>}
            >
              {data.entitlements.trial
                ? 'The free trial includes 1 brand. Choose a plan (or add extra brands) to run more.'
                : `You are using all ${plural(data.limit, 'brand')} on your plan. Archive one, or add an extra brand to your plan.`}
            </Notice>
          ) : null}
        </Card>

        <Card title="New brand">
          <ActionForm action={actions.create} resetOnSuccess className="grid gap-4 sm:grid-cols-[2fr_2fr_auto] sm:items-end" aria-label="Create a brand">
            <div>
              <label htmlFor="brand-name" className={label}>
                Name
              </label>
              <input id="brand-name" name="name" required maxLength={80} placeholder="e.g. The Morning Show" className={cx(input, 'mt-1')} disabled={atLimit || !canCreate} />
            </div>
            <div>
              <label htmlFor="brand-tz" className={label}>
                Time zone
              </label>
              <TimeZoneSelect id="brand-tz" options={timeZoneOptions()} disabled={atLimit || !canCreate} />
            </div>
            <SubmitButton disabled={atLimit || !canCreate} pendingLabel="Creating…">
              Create brand
            </SubmitButton>
          </ActionForm>
        </Card>

        <ul className="space-y-4" aria-label="Brands">
          {data.brands.map((b) => (
            <li key={b.id}>
              <Card as="article">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold">{b.name}</h2>
                    <p className="text-sm text-neutral-600 dark:text-neutral-400">
                      {b.timezone.replace(/_/g, ' ')} · {plural(data.accountsByBrand[b.id] ?? 0, 'connected account')} · created {formatDate(b.createdAt)}
                    </p>
                  </div>
                  <StatusPill status={b.status} label={b.status === 'suspended' ? 'Paused (over plan limit)' : undefined} />
                </div>

                {b.status !== 'archived' ? (
                  <details className="mt-4">
                    <summary className="cursor-pointer select-none text-sm font-medium text-indigo-700 dark:text-indigo-300">Rename or change time zone</summary>
                    <ActionForm action={actions.update} className="mt-3 grid gap-4 sm:grid-cols-[2fr_2fr_auto] sm:items-end">
                      <input type="hidden" name="brandId" value={b.id} />
                      <div>
                        <label htmlFor={`name-${b.id}`} className={label}>
                          Name
                        </label>
                        <input id={`name-${b.id}`} name="name" defaultValue={b.name} required maxLength={80} className={cx(input, 'mt-1')} />
                      </div>
                      <div>
                        <label htmlFor={`tz-${b.id}`} className={label}>
                          Time zone
                        </label>
                        <ZoneSelect id={`tz-${b.id}`} defaultValue={b.timezone} />
                      </div>
                      <SubmitButton variant="secondary" pendingLabel="Saving…">
                        Save
                      </SubmitButton>
                    </ActionForm>
                  </details>
                ) : null}

                <div className="mt-4 flex flex-wrap gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
                  {b.status === 'archived' || b.status === 'suspended' ? (
                    <ActionForm action={actions.restore}>
                      <input type="hidden" name="brandId" value={b.id} />
                      <SubmitButton variant="secondary" pendingLabel="Restoring…" disabled={atLimit}>
                        Restore
                      </SubmitButton>
                    </ActionForm>
                  ) : null}
                  {b.status !== 'archived' ? (
                    <ActionForm
                      action={actions.archive}
                      confirm={`Archive “${b.name}”? Its scheduled posts are canceled and its social accounts are disconnected. You can restore it later, but you will need to reconnect its accounts.`}
                    >
                      <input type="hidden" name="brandId" value={b.id} />
                      <SubmitButton variant="danger" pendingLabel="Archiving…">
                        Archive
                      </SubmitButton>
                    </ActionForm>
                  ) : null}
                  {b.status !== 'archived' ? (
                    <p className="basis-full text-xs text-neutral-500">
                      Archiving cancels its scheduled posts and its accounts are disconnected; reconnect them if you restore it.
                    </p>
                  ) : (
                    <p className="text-xs text-neutral-500">Archived brands keep their drafts and history. Restoring needs a free brand slot; reconnect its accounts afterwards.</p>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
