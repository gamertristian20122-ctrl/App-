// The legal pages' values from the environment (lib/ui/legal.ts). A broken configuration elsewhere
// must not take these public pages down: they then show placeholders. Server-only.

import { loadConfig, type EnvSource } from '@app/core/config'
import { legalInfo, type LegalInfo } from '@/lib/ui/legal'

export function legalInfoFromEnv(env: EnvSource): LegalInfo {
  try {
    const c = loadConfig(env)
    return legalInfo({
      LEGAL_ENTITY_NAME: c.LEGAL_ENTITY_NAME,
      SUPPORT_EMAIL: c.SUPPORT_EMAIL,
      LEGAL_JURISDICTION: c.LEGAL_JURISDICTION,
      LEGAL_EFFECTIVE_DATE: c.LEGAL_EFFECTIVE_DATE,
      APP_URL: c.APP_URL,
    })
  } catch {
    return legalInfo({})
  }
}
