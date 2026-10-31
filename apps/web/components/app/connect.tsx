// How to add the MCP server to Claude, ChatGPT and Cursor, plus the AI apps already connected.

import type { ReactNode } from 'react'
import type { OAuthConnection } from '@app/services'
import { ActionForm, SubmitButton, type FormAction } from '@/components/ui/action-form'
import { CopyButton } from '@/components/ui/copy-button'
import { Card, EmptyState, PageHeader } from '@/components/ui/primitives'
import { PRODUCT_NAME, PRODUCT_SLUG } from '@/lib/ui/brand'
import { formatDateTime } from '@/lib/ui/format'

/** The Cursor mcp.json snippet for this server. */
export function cursorConfig(mcpUrl: string): string {
  return JSON.stringify({ mcpServers: { [PRODUCT_SLUG]: { url: mcpUrl } } }, null, 2)
}

function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="list-decimal space-y-1.5 pl-5 text-sm text-neutral-700 dark:text-neutral-300">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ol>
  )
}

const PROMPTS = [
  'Draft a LinkedIn and X post about our launch, in my voice.',
  'Pick the 5 best clips from my latest video and draft posts for TikTok and YouTube Shorts.',
  'Schedule my approved drafts for tomorrow at 9am.',
  'Run my weekly review and suggest three experiments.',
]

export function ConnectView({ mcpUrl, connections, revoke, timezone }: { mcpUrl: string; connections: OAuthConnection[]; revoke: FormAction; timezone: string }) {
  const snippet = cursorConfig(mcpUrl)
  return (
    <>
      <PageHeader
        title="Connect your AI"
        description={`${PRODUCT_NAME} works inside the AI app you already use. Add this server once; your AI gets tools to draft, clip, schedule and review, and you approve everything.`}
      />
      <div className="space-y-6">
        <Card title="Your server URL">
          <div className="flex flex-wrap items-center gap-3">
            <code className="min-w-0 flex-1 break-all rounded-lg bg-neutral-100 px-3 py-2 font-mono text-sm dark:bg-neutral-950" data-testid="mcp-url">
              {mcpUrl}
            </code>
            <CopyButton value={mcpUrl} label="Copy URL" />
          </div>
          <p className="mt-2 text-xs text-neutral-500">
            When your AI app asks, sign in with this account and allow access. Nothing is published until you approve it.
          </p>
        </Card>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card title="Claude" description="Claude.ai on the web, desktop and mobile (custom connector).">
            <Steps
              items={[
                <>Open <strong>Settings → Connectors</strong>.</>,
                <>Choose <strong>Add custom connector</strong>.</>,
                <>Name it {PRODUCT_NAME} and paste the server URL.</>,
                <>Click <strong>Connect</strong>, sign in here, and allow access.</>,
                <>In a chat, turn {PRODUCT_NAME} on from the tools menu.</>,
              ]}
            />
          </Card>
          <Card title="ChatGPT" description="Developer mode connector.">
            <Steps
              items={[
                <>Open <strong>Settings → Apps &amp; Connectors → Advanced settings</strong> and turn on <strong>Developer mode</strong>.</>,
                <>Back in Apps &amp; Connectors, choose <strong>Create</strong>.</>,
                <>Name it {PRODUCT_NAME}, paste the server URL and pick <strong>OAuth</strong> authentication.</>,
                <>Sign in here and allow access.</>,
                <>In a chat, add {PRODUCT_NAME} from the <strong>+</strong> menu.</>,
              ]}
            />
          </Card>
          <Card title="Cursor" description="Add it to mcp.json.">
            <p className="text-sm text-neutral-700 dark:text-neutral-300">
              Paste into <code className="font-mono text-xs">~/.cursor/mcp.json</code> (all projects) or <code className="font-mono text-xs">.cursor/mcp.json</code> (one project):
            </p>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-neutral-950 p-3 font-mono text-xs text-neutral-100" data-testid="cursor-config">
              {snippet}
            </pre>
            <div className="mt-2 flex items-center justify-between gap-2">
              <CopyButton value={snippet} label="Copy JSON" />
              <span className="text-xs text-neutral-500">Then sign in from Cursor Settings → MCP.</span>
            </div>
          </Card>
        </div>

        <Card title="Try asking">
          <ul className="grid gap-2 sm:grid-cols-2">
            {PROMPTS.map((p) => (
              <li key={p} className="rounded-lg bg-neutral-50 px-3 py-2 text-sm italic dark:bg-neutral-950">
                “{p}”
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Connected AI apps" description="Apps that can use your account. Disconnect one to sign it out.">
          {connections.length === 0 ? (
            <EmptyState title="No AI app connected yet">Follow the steps above; the app shows up here after you sign in.</EmptyState>
          ) : (
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800" aria-label="Connected AI apps">
              {connections.map((c) => (
                <li key={c.familyId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="text-sm font-medium">{c.clientName ?? 'AI app'}</p>
                    <p className="text-xs text-neutral-500">
                      Connected {formatDateTime(c.connectedAt, timezone)}
                      {c.lastUsedAt ? ` · last used ${formatDateTime(c.lastUsedAt, timezone)}` : ''}
                    </p>
                  </div>
                  <ActionForm action={revoke} confirm="Disconnect this app? It must sign in again to use your account.">
                    <input type="hidden" name="familyId" value={c.familyId} />
                    <SubmitButton variant="danger" pendingLabel="Disconnecting…">
                      Disconnect
                    </SubmitButton>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  )
}
