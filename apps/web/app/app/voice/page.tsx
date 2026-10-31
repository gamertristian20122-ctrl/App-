import type { Metadata } from 'next'
import { VoiceView } from '@/components/app/voice'
import { loadVoice } from '@/lib/ui/data'
import { pageContext } from '@/lib/ui/server'
import { saveVoiceAction, saveVoiceJsonAction } from '../actions'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Voice' }

export default async function VoicePage() {
  const ctx = await pageContext('/app/voice')
  const data = ctx.brand ? await loadVoice(ctx.services, ctx.user.id, ctx.brand.id) : null
  return <VoiceView brand={ctx.brand} data={data} actions={{ save: saveVoiceAction, saveJson: saveVoiceJsonAction }} />
}
