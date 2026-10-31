// Voice profile editor for the selected brand: a structured form and a raw JSON editor, both saved
// through services.voice (validated with the core VoiceProfileSchema) as a new version.

import { EMOJI_POLICIES, HASHTAG_POLICIES, type VoiceProfile } from '@app/core/validation'
import { PLATFORM_LABELS, type Platform } from '@app/core/types'
import type { BrandRow } from '@app/db'
import { ActionForm, SubmitButton, type FormAction } from '@/components/ui/action-form'
import { Card, EmptyState, LinkButton, PageHeader } from '@/components/ui/primitives'
import { cx, hint, input, label } from '@/components/ui/styles'
import type { VoiceData } from '@/lib/ui/data'
import { formatDate, plural } from '@/lib/ui/format'

export interface VoiceActions {
  save: FormAction
  saveJson: FormAction
}

const EMPTY_PROFILE: VoiceProfile = {
  tone: '',
  audience: '',
  vocabulary: [],
  do: [],
  dont: [],
  emoji_policy: 'sparing',
  hashtag_policy: 'few',
  sample_posts: [],
}

const POLICY_LABELS: Record<string, string> = {
  none: 'None',
  sparing: 'Sparing',
  moderate: 'Moderate',
  heavy: 'Heavy',
  few: 'A few',
  many: 'Many',
}

/** Sample posts as editable text: blocks separated by "---", optional "[platform]" prefix. */
export function samplesToText(samples: VoiceProfile['sample_posts']): string {
  return samples.map((s) => (s.platform ? `[${s.platform}] ${s.text}` : s.text)).join('\n---\n')
}

function Area({ id, name, title, help, defaultValue, rows = 3, max }: { id: string; name: string; title: string; help?: string; defaultValue: string; rows?: number; max?: number }) {
  return (
    <div>
      <label htmlFor={id} className={label}>
        {title}
      </label>
      {help ? <p className={hint}>{help}</p> : null}
      <textarea id={id} name={name} rows={rows} defaultValue={defaultValue} maxLength={max} className={cx(input, 'mt-1')} />
    </div>
  )
}

export function VoiceView({ brand, data, actions }: { brand: BrandRow | null; data: VoiceData | null; actions: VoiceActions }) {
  if (!brand || !data) {
    return (
      <>
        <PageHeader title="Voice" />
        <EmptyState title="Create a brand first" action={<LinkButton href="/app/brands" variant="primary">Create a brand</LinkButton>}>
          Each brand has its own voice profile.
        </EmptyState>
      </>
    )
  }
  const p = data.profile?.profile ?? EMPTY_PROFILE
  const imported = Object.entries(data.imported.byPlatform) as Array<[Platform, number]>
  return (
    <>
      <PageHeader
        title="Voice"
        description={`How ${brand.name} sounds. Your AI loads this profile before it writes anything, so every draft sounds like you.`}
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_18rem]">
        <div className="min-w-0 space-y-6">
          <Card title="Voice profile" description={data.profile ? `Version ${data.profile.version}, saved ${formatDate(data.profile.createdAt)}` : 'Not set yet.'}>
            <ActionForm action={actions.save} className="space-y-5" aria-label="Voice profile">
              <input type="hidden" name="brandId" value={brand.id} />
              <Area id="v-tone" name="tone" title="Tone" help="How you sound, e.g. “warm, direct, a little nerdy; short sentences”." defaultValue={p.tone} max={500} />
              <Area id="v-audience" name="audience" title="Audience" help="Who you talk to and what they care about." defaultValue={p.audience} max={500} />
              <div className="grid gap-5 md:grid-cols-3">
                <Area id="v-vocab" name="vocabulary" title="Words you use" help="One per line." defaultValue={p.vocabulary.join('\n')} rows={5} />
                <Area id="v-do" name="do" title="Do" help="One rule per line." defaultValue={p.do.join('\n')} rows={5} />
                <Area id="v-dont" name="dont" title="Don't" help="One rule per line." defaultValue={p.dont.join('\n')} rows={5} />
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <div>
                  <label htmlFor="v-emoji" className={label}>
                    Emoji
                  </label>
                  <select id="v-emoji" name="emoji_policy" defaultValue={p.emoji_policy} className={cx(input, 'mt-1')}>
                    {EMOJI_POLICIES.map((e) => (
                      <option key={e} value={e}>
                        {POLICY_LABELS[e] ?? e}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="v-hashtags" className={label}>
                    Hashtags
                  </label>
                  <select id="v-hashtags" name="hashtag_policy" defaultValue={p.hashtag_policy} className={cx(input, 'mt-1')}>
                    {HASHTAG_POLICIES.map((h) => (
                      <option key={h} value={h}>
                        {POLICY_LABELS[h] ?? h}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <Area
                id="v-samples"
                name="sample_posts"
                title="Sample posts"
                help="Posts that sound like you (up to 30). Separate them with a line containing only ---. Start one with [x], [linkedin]… to tag its platform."
                defaultValue={samplesToText(p.sample_posts)}
                rows={8}
              />
              <SubmitButton pendingLabel="Saving…">Save new version</SubmitButton>
            </ActionForm>
          </Card>

          <Card title="Edit as JSON" description="The same profile your AI reads. Saved as a new version after validation.">
            <details>
              <summary className="cursor-pointer select-none text-sm font-medium text-indigo-700 dark:text-indigo-300">Show the JSON editor</summary>
              <ActionForm action={actions.saveJson} className="mt-3 space-y-3" inline>
                <input type="hidden" name="brandId" value={brand.id} />
                <label htmlFor="v-json" className="sr-only">
                  Voice profile JSON
                </label>
                <textarea id="v-json" name="json" rows={16} spellCheck={false} defaultValue={JSON.stringify(p, null, 2)} className={cx(input, 'font-mono text-xs')} />
                <SubmitButton variant="secondary" pendingLabel="Saving…">
                  Save JSON
                </SubmitButton>
              </ActionForm>
            </details>
          </Card>
        </div>

        <aside className="space-y-6">
          <Card title="Imported posts">
            <p className="text-sm">{plural(data.imported.total, 'past post')} imported.</p>
            {imported.length > 0 ? (
              <ul className="mt-2 space-y-1 text-sm text-neutral-600 dark:text-neutral-400">
                {imported.map(([platform, n]) => (
                  <li key={platform}>
                    {PLATFORM_LABELS[platform]}: {n}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="mt-3 text-xs text-neutral-500">Ask your AI to “import my past posts and build my voice profile”. It reads them and fills this in.</p>
          </Card>
          <Card title="History">
            {data.versions.length === 0 ? (
              <p className="text-sm text-neutral-500">No versions yet.</p>
            ) : (
              <ol className="space-y-1 text-sm">
                {data.versions.map((v) => (
                  <li key={v.version} className="flex justify-between gap-2">
                    <span>Version {v.version}</span>
                    <span className="text-neutral-500">
                      {v.source} · {formatDate(v.createdAt)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </aside>
      </div>
    </>
  )
}
