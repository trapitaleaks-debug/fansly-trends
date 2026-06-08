/**
 * Standalone character sheet generator.
 * Builds the reference sheet from source photos and saves to R2.
 * Use this to preview/test the sheet before running a full generation cycle.
 *
 *   npm run pipeline:sheet -- --handle liisaofficial
 */

import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import fs from 'fs'
import os from 'os'
import path from 'path'
import { getModel } from './db'
import { generateCharacterSheet } from './generate'
import { getSignedVideoUrl } from '../lib/r2'

const args = process.argv.slice(2)
const handleIdx = args.indexOf('--handle')
const handle = handleIdx !== -1 ? args[handleIdx + 1] : undefined

if (!handle) {
  console.error('Usage: npm run pipeline:sheet -- --handle <fansly_handle>')
  process.exit(1)
}

async function run() {
  const model = await getModel(handle!)
  if (!model) throw new Error(`Model @${handle} not found in pipeline_models`)

  console.log(`\nGenerating character sheet for @${handle}...`)
  console.log('This takes ~8 minutes. Leave it running.\n')

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kie_sheet_'))
  try {
    const sheetKey = await generateCharacterSheet(model, tmpDir)
    const signedUrl = await getSignedVideoUrl(sheetKey, 3600)
    console.log('\n✅ Done. Open this URL to preview the sheet (valid 1h):')
    console.log(signedUrl)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

run().catch(e => { console.error('\n✗', e.message); process.exit(1) })
