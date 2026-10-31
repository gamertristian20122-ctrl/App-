// Connected social accounts for one brand: connect (hosted connect page), refresh, disconnect.

import { PLATFORM_LABELS } from '@app/core/types'
import type { BrandRow } from '@app/db'
import { PlatformMark } from '@/components/platform/platform-badge'
import { ActionForm, SubmitButton, type FormAction } from '@/components/ui/action-form'
import { Card, EmptyState, LinkButton, Notice, PageHeader, StatusPill } from '@/components/ui/primitives'
import type { AccountSlot } from '@/lib/ui/data'
import { formatDateTime, plural } from '@/lib/ui/format'

export interface AccountActions {
  connect: FormAction
  sync: FormAction
  disconnect: FormAction
}

export function AccountsView({
  brand,
  slots,
  connected,
  actions,
  notice,
}: {
  brand: BrandRow | null
  slots: AccountSlot[]
  connected: number
  actions: AccountActions
  notice?: { tone: 'success' | 'warning' | 'danger'; text: string } | null
}) {
  if (!brand) {
    return (
      <>
        <PageHeader title="Accounts" />
        <EmptyState title="Create a brand first" action={<LinkButton href="/app/brands" variant="primary">Create a brand</LinkButton>}>
          Social accounts belong to a brand. Create one, then connect its accounts here.
        </EmptyState>
      </>
    )
  }
  const paused = brand.status !== 'active'
  return (
    <>
      <PageHeader
        title="Accounts"
        description={`Social accounts ${brand.name} posts to. One account per platform; ${plural(connected, 'account')} connected.`}
        actions={
          <ActionForm action={actions.sync}>
            <input type="hidden" name="brandId" value={brand.id} />
            <SubmitButton variant="secondary" pendingLabel="Refreshing…">
              Refresh
            </SubmitButton>
          </ActionForm>
        }
      />
      {notice ? (
        <Notice tone={notice.tone} className="mb-4">
          {notice.text}
        </Notice>
      ) : null}
      {paused ? (
        <Notice tone="warning" className="mb-4" action={<LinkButton href="/app/billing">Billing</LinkButton>}>
          This brand is paused because your plan has fewer brands. Its accounts cannot be connected until it is active again.
        </Notice>
      ) : null}
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Platforms">
        {slots.map(({ platform, account }) => {
          const label = PLATFORM_LABELS[platform]
          const needsAction = account && account.status !== 'active'
          return (
            <li key={platform}>
              <Card as="article" className="flex h-full flex-col">
                <div className="flex items-center gap-3">
                  <PlatformMark platform={platform} size="lg" />
                  <div className="min-w-0 flex-1">
                    <h2 className="font-semibold">{label}</h2>
                    {account ? (
                      <p className="truncate text-sm text-neutral-600 dark:text-neutral-400">
                        {account.handle ? `@${account.handle.replace(/^@/, '')}` : (account.displayName ?? 'Connected')}
                      </p>
                    ) : (
                      <p className="text-sm text-neutral-500">Not connected</p>
                    )}
                  </div>
                  {account ? <StatusPill status={account.status} /> : null}
                </div>
                {account?.lastSyncedAt ? <p className="mt-2 text-xs text-neutral-500">Checked {formatDateTime(account.lastSyncedAt, brand.timezone)}</p> : null}
                <div className="mt-auto flex flex-wrap gap-2 pt-4">
                  {!account || needsAction ? (
                    <ActionForm action={actions.connect}>
                      <input type="hidden" name="brandId" value={brand.id} />
                      <input type="hidden" name="platform" value={platform} />
                      <SubmitButton variant={account ? 'secondary' : 'primary'} disabled={paused} pendingLabel="Opening…">
                        {account ? 'Reconnect' : 'Connect'}
                        <span className="sr-only"> {label}</span>
                      </SubmitButton>
                    </ActionForm>
                  ) : null}
                  {account ? (
                    <ActionForm action={actions.disconnect} confirm={`Disconnect ${label}? Scheduled ${label} posts for this brand will be canceled.`}>
                      <input type="hidden" name="accountId" value={account.id} />
                      <SubmitButton variant="ghost" pendingLabel="Disconnecting…">
                        Disconnect
                        <span className="sr-only"> {label}</span>
                      </SubmitButton>
                    </ActionForm>
                  ) : null}
                </div>
              </Card>
            </li>
          )
        })}
      </ul>
      <p className="mt-6 text-xs text-neutral-500">
        Connecting opens a secure page from our posting partner where you sign in to the platform. We never see your social passwords.
      </p>
    </>
  )
}
