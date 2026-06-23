/**
 * Bulk upload own-footage reels to R2 + insert pipeline_content_bank records.
 *
 * Usage:
 *   npx tsx pipeline/bulk-upload-reels.ts
 *
 * Only processes models that have 0 records in pipeline_content_bank (safe to re-run).
 * Skips models already fully uploaded.
 */

import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import fs from 'fs'
import path from 'path'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { createClient } from '@supabase/supabase-js'

// Build clients AFTER dotenv has loaded
const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
})
const R2_BUCKET = process.env.R2_BUCKET_NAME ?? 'fansly-trends'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function uploadToR2(key: string, body: Buffer, contentType: string) {
  await r2Client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: body, ContentType: contentType }))
}

const supabaseAdmin = supabase

const REELS_BASE = '/Users/leonardoguizzo/Documents/Obsidian/reels-to-organize'
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v'])

// Number → handle mapping (from Personal Branding Files)
const MODEL_MAP: Record<number, string> = {
  1: 'XiaohongshuShawty',
  2: 'MissFortuneMILF',
  3: 'DariaFlorescu',
  4: 'DumbBlondeBimbo',
  5: 'tiffanyloves',
  6: 'yourfavyasmin',
  7: 'LilaHanal',
  8: 'mollylovescuddles',
  9: 'MochiBKK',
  10: 'NichaSinner',
  11: 'MintControl',
  12: 'EmilyBossetti',
  13: 'SurfersParadise',
  14: 'DimSumShawty',
  15: 'candecakes',
  16: 'lilybrookss',
  17: 'lunaviola',
  18: 'CousCousShawty',
  19: 'minamochi',
  20: 'sweetgothchick',
  21: 'ashleykiss',
  22: 'stellashyx',
  23: 'emilyxcutie',
}

function getContentType(ext: string): string {
  const map: Record<string, string> = {
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    m4v: 'video/mp4',
  }
  return map[ext.replace('.', '')] ?? 'video/mp4'
}

async function getModelId(handle: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('pipeline_models')
    .select('id')
    .ilike('handle', handle)
    .single()
  return data?.id ?? null
}

async function getExistingCount(modelId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from('pipeline_content_bank')
    .select('id', { count: 'exact', head: true })
    .eq('model_id', modelId)
    .eq('type', 'own_footage')
  return count ?? 0
}

async function uploadModelReels(num: number, handle: string) {
  const folderName = `${num}. Reels`
  const modelFolder = path.join(REELS_BASE, folderName)

  if (!fs.existsSync(modelFolder)) {
    console.log(`  [${num}] ${handle}: folder not found, skipping`)
    return { skipped: true, uploaded: 0 }
  }

  const modelId = await getModelId(handle)
  if (!modelId) {
    console.log(`  [${num}] ${handle}: NOT in pipeline_models — skipping`)
    return { skipped: true, uploaded: 0 }
  }

  const existingCount = await getExistingCount(modelId)
  if (existingCount > 0) {
    console.log(`  [${num}] ${handle}: already has ${existingCount} records — skipping`)
    return { skipped: true, uploaded: 0 }
  }

  // Collect all video files from Unedited and Edited subfolders
  const videoFiles: string[] = []
  const subfolders = fs.readdirSync(modelFolder).filter(f => !f.startsWith('.'))

  for (const sub of subfolders) {
    const subPath = path.join(modelFolder, sub)
    if (!fs.statSync(subPath).isDirectory()) continue
    const files = fs.readdirSync(subPath).filter(f => {
      const ext = path.extname(f).toLowerCase()
      return VIDEO_EXTS.has(ext) && !f.startsWith('.')
    })
    for (const f of files) {
      videoFiles.push(path.join(subPath, f))
    }
  }

  if (videoFiles.length === 0) {
    console.log(`  [${num}] ${handle}: no video files found`)
    return { skipped: false, uploaded: 0 }
  }

  console.log(`  [${num}] ${handle}: uploading ${videoFiles.length} files...`)

  const rows: Array<{
    model_id: string
    r2_key: string
    type: string
    label: string
    trim_start: number
    trim_end: null
  }> = []

  let uploadedCount = 0
  for (const filePath of videoFiles) {
    const filename = path.basename(filePath)
    const ext = path.extname(filename).toLowerCase()
    const contentType = getContentType(ext)
    const ts = Date.now()
    const r2Key = `models/${handle}/bank/own_footage/${ts}_${filename}`

    try {
      const buf = fs.readFileSync(filePath)
      await uploadToR2(r2Key, buf, contentType)
      rows.push({
        model_id: modelId,
        r2_key: r2Key,
        type: 'own_footage',
        label: filename,
        trim_start: 0,
        trim_end: null,
      })
      uploadedCount++
      process.stdout.write(`    ${uploadedCount}/${videoFiles.length}\r`)
    } catch (e) {
      console.error(`\n    ✗ Failed to upload ${filename}: ${(e as Error).message}`)
    }
  }

  console.log(`\n    Uploaded ${uploadedCount} files to R2`)

  if (rows.length > 0) {
    const { error } = await supabaseAdmin
      .from('pipeline_content_bank')
      .insert(rows)
    if (error) {
      console.error(`    ✗ DB insert failed: ${error.message}`)
      return { skipped: false, uploaded: uploadedCount, dbError: error.message }
    }
    console.log(`    ✓ Inserted ${rows.length} records into pipeline_content_bank`)
  }

  return { skipped: false, uploaded: uploadedCount }
}

async function main() {
  console.log('\n🚀 Bulk Reels Upload — R2 + pipeline_content_bank\n')

  const results: Record<string, { skipped: boolean; uploaded: number; dbError?: string }> = {}

  for (const [numStr, handle] of Object.entries(MODEL_MAP)) {
    const num = Number(numStr)
    const result = await uploadModelReels(num, handle)
    results[handle] = result
  }

  console.log('\n── Summary ──────────────────────────────────────')
  let totalUploaded = 0
  let totalSkipped = 0
  for (const [handle, res] of Object.entries(results)) {
    if (res.skipped) {
      totalSkipped++
    } else {
      totalUploaded += res.uploaded
      console.log(`  ✓ ${handle}: ${res.uploaded} files${res.dbError ? ' (DB ERROR: ' + res.dbError + ')' : ''}`)
    }
  }
  console.log(`\n  Skipped (already done): ${totalSkipped}`)
  console.log(`  Total new files uploaded: ${totalUploaded}`)
  console.log('\n✅ Done')
}

main().catch(e => {
  console.error('\n✗ Fatal:', e)
  process.exit(1)
})
