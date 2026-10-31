'use server'

// Server actions for the dashboard. Each one checks the session, runs one function from
// lib/ui/actions (which calls one services function) and returns a short result for the form's
// toast. Approvals always go through services.approvals with the card nonce issued at render
// time and { via: 'web' }. Next.js checks every action's origin (CSRF).

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import type { ActionResult } from '@/lib/ui/action-result'
import { approveDraft, archiveDraft, cancelPost, editVariant, rejectDraft, reopenDraft, reschedulePost, scheduleDraft } from '@/lib/ui/actions/drafts'
import {
  addDriveLink,
  archiveBrand,
  connectAccount,
  createBrand,
  deleteMedia,
  disconnectAccount,
  requestClip,
  restoreBrand,
  revokeAiConnection,
  saveVoiceProfile,
  saveVoiceProfileJson,
  syncAccounts,
  updateBrand,
} from '@/lib/ui/actions/settings'
import { isId } from '@/lib/ui/form'
import { currentUser, getUiRuntime } from '@/lib/ui/runtime'
import { rememberBrand, runAction } from '@/lib/ui/server'

// ----- brand switcher ------------------------------------------------------------------------

export async function selectBrandAction(formData: FormData): Promise<void> {
  const brandId = formData.get('brandId')
  const user = await currentUser()
  if (!user || !isId(brandId)) return
  const rt = await getUiRuntime()
  try {
    const brand = await rt.services.brands.get(user.id, brandId)
    if (brand.status === 'archived') return
    await rememberBrand(brand.id, rt.appUrl.startsWith('https://'))
  } catch {
    return
  }
  revalidatePath('/app', 'layout')
}

// ----- approvals -----------------------------------------------------------------------------

export async function approveAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => approveDraft(services, userId, fd))
}

export async function rejectAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => rejectDraft(services, userId, fd))
}

export async function editVariantAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => editVariant(services, userId, fd))
}

export async function reopenDraftAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => reopenDraft(services, userId, fd))
}

export async function archiveDraftAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => archiveDraft(services, userId, fd))
}

// ----- scheduling ----------------------------------------------------------------------------

export async function scheduleDraftAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => scheduleDraft(services, userId, fd))
}

export async function reschedulePostAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => reschedulePost(services, userId, fd))
}

export async function cancelPostAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => cancelPost(services, userId, fd))
}

// ----- brands and accounts -------------------------------------------------------------------

export async function createBrandAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => createBrand(services, userId, fd))
}

export async function updateBrandAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => updateBrand(services, userId, fd))
}

export async function archiveBrandAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => archiveBrand(services, userId, fd))
}

export async function restoreBrandAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => restoreBrand(services, userId, fd))
}

export async function connectAccountAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  let url: string | undefined
  const result = await runAction(async ({ services, userId, rt }) => {
    const out = await connectAccount(services, userId, fd, rt.appUrl)
    url = out.url
    return out.result
  })
  // Outside runAction: redirect() throws to navigate (to the provider's hosted connect page).
  if (result.ok && url) redirect(url)
  return result
}

export async function syncAccountsAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => syncAccounts(services, userId, fd))
}

export async function disconnectAccountAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => disconnectAccount(services, userId, fd))
}

// ----- media, clips, voice, AI connections ---------------------------------------------------

export async function addDriveLinkAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => addDriveLink(services, userId, fd))
}

export async function deleteMediaAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => deleteMedia(services, userId, fd))
}

export async function requestClipAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => requestClip(services, userId, fd))
}

export async function saveVoiceAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => saveVoiceProfile(services, userId, fd))
}

export async function saveVoiceJsonAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => saveVoiceProfileJson(services, userId, fd))
}

export async function revokeAiConnectionAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction(({ services, userId }) => revokeAiConnection(services, userId, fd))
}

/** After a browser upload finishes (client component), refresh the media list. */
export async function refreshMediaAction(): Promise<void> {
  revalidatePath('/app/media')
  revalidatePath('/app/clips')
}
