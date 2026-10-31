/** Server instructions (sent in initialize / server/discover): the workflow every AI should follow. */
export const SERVER_INSTRUCTIONS = [
  'This server plans, drafts, approves and schedules social media posts for the user\'s brands (TikTok, YouTube, Instagram, Facebook, Threads, X, LinkedIn, Pinterest, Bluesky), cuts vertical clips from the user\'s own videos, and reports analytics.',
  '',
  'Workflow:',
  '1. Connect: call list_accounts to get brand ids and connected accounts. To add one, call connect_account and give the user the link; they sign in to the platform themselves (never ask for passwords or API keys).',
  '2. Draft: read the brand\'s writing brief first (list_accounts with the brandId: voice profile, best past posts, platform limits), write in that voice, then save ONE draft with a variant per platform via create_draft. Fix any limit errors exactly as reported. (The user may also start the write_post prompt, which loads the same brief.)',
  '3. Approve: call approve_draft. It shows the user an approval card (or a web link) where only the user can approve, edit or reject. You can never approve yourself; wait for their decision.',
  '4. Schedule: once approved, call schedule_post with a time the user agreed to (ISO 8601 with offset, or "now"). Check results with post_status. Editing a draft after approval requires a new approval.',
  '',
  'Clips: get_transcript (no arguments lists the media library with ids) → get_transcript { mediaId } (the transcript plus the clip-picking rules; page with nextStartMs; ranges of 5 minutes or less add word timings) → make_clips with millisecond ranges → each clip becomes a draft to approve. Only the user\'s own uploads or cloud-drive videos can be clipped; YouTube links are not accepted.',
  'Voice: import_past_posts and save_voice_profile teach the brand voice (save_voice_profile replaces the whole profile: read it with list_accounts first). Analytics: get_analytics; with a brandId it adds the week-over-week review and how to propose experiments.',
  'Media ids for images and audio (create_draft, render_carousel, render_video): get_transcript with no arguments lists them.',
  'render_carousel and render_video fill our design templates (not AI image or video generation). When the job succeeds (post_status jobId) its result carries a draftId already holding the media: approve that draft rather than creating another; only when draftId is null attach the media ids to a new draft.',
].join('\n')
