// Brands: create (within the plan's limit), rename / change time zone, archive and restore, and the
// Auto-post switch (videos the user's AI sends are posted without asking; only changed here).

import { AUTO_POST_DAILY_MAX, BEST_TIME_SLOTS } from '@app/core/autopost'
import { PLATFORM_RULES } from '@app/core/platforms'
import { PLATFORMS, PLATFORM_LABELS, type Platform } from '@app/core/types'
import { TIKTOK_PRIVACY_LABELS, TIKTOK_PRIVACY_LEVELS } from '@app/core/validation'
import type { BrandRow } from '@app/db'
import { ActionForm, SubmitButton, type FormAction } from '@/components/ui/action-form'
import { Badge, Card, LinkButton, Meter, Notice, PageHeader, StatusPill } from '@/components/ui/primitives'
import { cx, hint, input, label } from '@/components/ui/styles'
import type { BrandsData } from '@/lib/ui/data'
import { formatDate, plural } from '@/lib/ui/format'
import { timeZoneOptions } from '@/lib/ui/time'
import { TimeZoneSelect } from './time-zone-select'

export interface BrandActions {
  create: FormAction
  update: FormAction
  archive: FormAction
  restore: FormAction
  autoPost: FormAction
}

/** The warning shown with the switch (also checked by the e2e run). */
export const AUTO_POST_WARNING = 'When this is on, videos your AI sends are posted without asking you. Platform limits still apply.'

const VIDEO_PLATFORMS = PLATFORMS.filter((p) => PLATFORM_RULES[p].video !== null)

/** Auto-post: switch, platforms (none ticked = every connected one), daily limit, TikTok privacy. */
function AutoPostForm({ brand, connected, action }: { brand: BrandRow; connected: readonly Platform[]; action: FormAction }) {
  const base = `auto-${brand.id}`
  const list = brand.autoPostPlatforms
  return (
    <section className="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800" aria-labelledby={`${base}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${base}-title`} className="text-sm font-semibold">
          Auto-post
        </h3>
        {brand.autoPostEnabled ? <Badge tone="warning">On: posts without asking</Badge> : <Badge>Off: every post waits for your approval</Badge>}
      </div>
      <Notice tone="warning" className="mt-3">
        {AUTO_POST_WARNING}
      </Notice>
      <ActionForm action={action} className="mt-3 space-y-4" aria-label={`Auto-post for ${brand.name}`}>
        <input type="hidden" name="brandId" value={brand.id} />
        <label htmlFor={`${base}-enabled`} className="flex items-center gap-2 text-sm font-medium">
          <input id={`${base}-enabled`} type="checkbox" name="enabled" role="switch" defaultChecked={brand.autoPostEnabled} className="h-4 w-4" />
          Post videos my AI sends automatically for {brand.name}
        </label>
        <fieldset>
          <legend className={label}>Platforms</legend>
          <p className={hint}>Tick none to allow every connected platform.</p>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {VIDEO_PLATFORMS.map((p) => (
              <label key={p} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="platforms" value={p} defaultChecked={list.includes(p)} className="h-4 w-4" />
                {PLATFORM_LABELS[p]}
                {connected.includes(p) ? null : <span className="text-xs text-neutral-500">(not connected)</span>}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${base}-max`} className={label}>
              Most auto-posts per day
            </label>
            <input
              id={`${base}-max`}
              name="dailyMax"
              type="number"
              min={AUTO_POST_DAILY_MAX.min}
              max={AUTO_POST_DAILY_MAX.max}
              defaultValue={brand.autoPostDailyMax}
              className={cx(input, 'mt-1')}
            />
            <p className={hint}>Counted over any 24 hours. Above it, videos wait for your approval.</p>
          </div>
          <div>
            <label htmlFor={`${base}-tiktok`} className={label}>
              Who can see auto-posted TikTok videos
            </label>
            <select id={`${base}-tiktok`} name="tiktokPrivacy" defaultValue={brand.autoPostTiktokPrivacy ?? 'PUBLIC_TO_EVERYONE'} className={cx(input, 'mt-1')}>
              {TIKTOK_PRIVACY_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {TIKTOK_PRIVACY_LABELS[l]}
                </option>
              ))}
            </select>
            <p className={hint}>TikTok asks you to choose this for every post.</p>
          </div>
        </div>
        <p className={hint}>
          Your AI picks the time: right away, a time you agreed on, or “best” (for example TikTok at {BEST_TIME_SLOTS.tiktok.join(' or ')}, YouTube at{' '}
          {BEST_TIME_SLOTS.youtube.join(', ')} in this brand&apos;s time zone). Cancel any post in the calendar.
        </p>
        <SubmitButton variant="secondary" pendingLabel="Saving…">
          Save Auto-post
        </SubmitButton>
      </ActionForm>
    </section>
  )
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

                {b.status !== 'archived' ? <AutoPostForm brand={b} connected={data.platformsByBrand[b.id] ?? []} action={actions.autoPost} /> : null}

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
