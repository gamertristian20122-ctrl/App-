#!/usr/bin/env node
// Prints fresh values for the secrets in .env.example (pnpm secrets). Paste them into your .env;
// never commit them. To rotate TOKEN_ENCRYPTION_KEYS, prepend the new key: "v2:new,v1:old".

import { randomBytes } from 'node:crypto'

const version = process.argv[2] ?? 'v1'
if (!/^[A-Za-z0-9_-]{1,32}$/.test(version)) {
  console.error('Usage: node scripts/generate-secrets.mjs [key-version]')
  process.exit(1)
}

console.log(`TOKEN_ENCRYPTION_KEYS=${version}:${randomBytes(32).toString('base64')}`)
console.log(`SESSION_SECRET=${randomBytes(32).toString('base64url')}`)
console.log(`CRON_SECRET=${randomBytes(24).toString('base64url')}`)
