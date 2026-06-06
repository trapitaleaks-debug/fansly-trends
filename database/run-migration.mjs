/**
 * Run SQL migrations against Supabase using the Management API.
 * Usage: DATABASE_URL=postgres://... node database/run-migration.mjs
 * Or set DATABASE_URL in .env.local and run: node -e "require('dotenv').config({path:'.env.local'})" database/run-migration.mjs
 *
 * Alternatively, paste the contents of 003_models_schema.sql into the Supabase SQL Editor at:
 * https://supabase.com/dashboard/project/krkezzuuyxfsihumbgut/editor
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const sql = readFileSync(join(__dirname, 'migrations/003_models_schema.sql'), 'utf-8')

// Supabase project ref and service role key
const PROJECT_REF = 'krkezzuuyxfsihumbgut'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtya2V6enV1eXhmc2lodW1iZ3V0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODE5OTQ0MywiZXhwIjoyMDkzNzc1NDQzfQ.z0-dYYqeZmbFE9TpLKRWgq7BnYai1sMlx43YhA319oA'

// Try Supabase Management API
const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ query: sql }),
})

if (res.ok) {
  console.log('✅ Migration ran successfully')
} else {
  const text = await res.text()
  console.error('❌ Migration API failed:', res.status, text.slice(0, 300))
  console.log('\n--- MANUAL FALLBACK ---')
  console.log('Paste the following SQL into the Supabase SQL Editor:')
  console.log('https://supabase.com/dashboard/project/krkezzuuyxfsihumbgut/editor')
  console.log('\n' + sql)
}
