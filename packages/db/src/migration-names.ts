// The migrations this code expects, embedded so they are known where supabase/migrations is not on
// disk (the Vercel function bundle). A test keeps it equal to the files in supabase/migrations;
// add the new file's name here when you add a migration.

export const MIGRATION_NAMES = [
  '0001_init',
  '0002_approval_nonce_channel',
  '0003_review_fixes',
  '0004_auto_post',
  '0005_launch_setup',
] as const

export type MigrationName = (typeof MIGRATION_NAMES)[number]
