/**
 * Phase 3 — Generation Engine
 * For each brief: generate 4 image variants → score → generate 4 video variants → score → save best
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import Anthropic from '@anthropic-ai/sdk'
import sharp from 'sharp'
import { uploadToR2, r2, getSignedVideoUrl } from '../lib/r2'
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { createImageTask, createVideoTask, pollTask, uploadFileToKie, sleep } from './kie'
import {
  getModel,
  createVideo,
  updateVideo,
  updateModelCharacterSheet,
  updateModelSheetPolling,
  updateModelSheetStatus,
  saveVariants,
  selectVariant,
  type PipelineModel,
  type Brief,
} from './db'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const BUCKET = process.env.R2_BUCKET_NAME ?? 'fansly-trends'

// ─── R2 download helper ───────────────────────────────────────────────────────

async function downloadFromR2(key: string, destPath: string): Promise<void> {
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  const body = res.Body
  if (!body) throw new Error(`R2 key not found: ${key}`)
  const chunks: Uint8Array[] = []
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk)
  fs.writeFileSync(destPath, Buffer.concat(chunks))
}

// ─── Quality scoring ──────────────────────────────────────────────────────────

async function scoreImage(imagePath: string, isGenerated = false): Promise<number> {
  const buffer = fs.readFileSync(imagePath)
  const data = buffer.toString('base64')
  const prompt = isGenerated
    ? 'Score this AI-generated image quality (0-10). Check: face looks natural (+3), no extra fingers or deformities (+2), natural lighting (+2), background makes sense (+2), not plastic/over-smoothed (+1). Return ONLY a JSON object: {"score":7}'
    : 'Score this image for video frame quality (0-10). Check: face clearly visible (+3), good lighting (+2), sharp focus (+3), natural expression (+2). Return ONLY JSON: {"score":7}'

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
          { type: 'text', text: prompt },
        ],
      }],
    })
    const text = (response.content[0] as { type: string; text: string }).text
    const match = text.match(/"score"\s*:\s*(\d+)/)
    return match ? Number(match[1]) : 5
  } catch {
    return 5
  }
}

// ─── Character sheet ──────────────────────────────────────────────────────────

// Exact GuizzField character sheet prompt — works when photos are compressed to ≤1024px before upload
const CHARACTER_SHEET_PROMPT =
  'A professional character reference sheet of the exact person from the reference images on a plain white background. ' +
  'Layout is two rows: top row has four close-up head shots equally sized side by side — front facing, left profile, right profile, back of head. ' +
  'Bottom row has three full body shots equally sized side by side — full body front, full body side profile, full body back. ' +
  'Replicate every detail from the reference exactly: facial structure, skin tone, natural blemishes, body proportions, hair color, texture and styling. ' +
  'Eyes with exact iris color. Soft neutral studio lighting, flat and even, no shadows. Every view perfectly consistent. Photorealistic, sharp micro detail.'

async function compressTo1024(inputPath: string, outputPath: string): Promise<void> {
  await sharp(inputPath)
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toFile(outputPath)
}

export async function generateCharacterSheet(model: PipelineModel, tmpDir: string): Promise<string> {
  // Download source photos from R2, compress to ≤1024px (same as GuizzField) before uploading.
  // Compression is what allows NSFW photos to pass kie.ai's input scanner — full-res uploads are blocked.
  const prefix = model.source_photos_r2_prefix ?? `models/${model.handle}/source`
  const listing = await r2.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix + '/' }))
  const keys = (listing.Contents ?? []).map(o => o.Key!).filter(Boolean).slice(0, 25)
  if (keys.length === 0) throw new Error(`No source photos at R2 prefix: ${prefix}`)

  const kieUrls: string[] = []
  for (const key of keys) {
    const filename = path.basename(key)
    const rawPath = path.join(tmpDir, `raw_${filename}`)
    const compPath = path.join(tmpDir, `comp_${path.parse(filename).name}.jpg`)
    await downloadFromR2(key, rawPath)
    await compressTo1024(rawPath, compPath)
    try {
      const url = await uploadFileToKie(compPath, path.basename(compPath), `pipeline/${model.handle}`)
      kieUrls.push(url)
      await sleep(600)
    } catch (e) {
      console.error(`  ✗ Upload failed for ${filename}:`, (e as Error).message)
    }
  }
  if (kieUrls.length < 3) throw new Error(`Too few photos uploaded to kie.ai (${kieUrls.length})`)

  // Generate 16:9 character sheet (GuizzField format)
  console.log(`  Generating character sheet from ${kieUrls.length} compressed photos...`)
  const taskId = await createImageTask(CHARACTER_SHEET_PROMPT, kieUrls, '16:9')
  const sheetUrl = await pollTask(taskId, 10 * 60 * 1000)

  // Download and store permanently in R2
  const buf = await fetch(sheetUrl).then(r => r.arrayBuffer())
  const sheetKey = `models/${model.handle}/reference/character_sheet.jpg`
  await uploadToR2(sheetKey, Buffer.from(new Uint8Array(buf)), 'image/jpeg')
  await updateModelCharacterSheet(model.id, sheetKey)

  console.log(`  ✓ Character sheet stored → ${sheetKey}`)
  return sheetKey
}

/**
 * Phase 1 of async sheet generation: download + compress + upload photos, create kie.ai task.
 * Stores the taskId and sets sheet_status='polling'. Returns immediately after task creation.
 */
export async function startCharacterSheetTask(model: PipelineModel, tmpDir: string): Promise<void> {
  const prefix = model.source_photos_r2_prefix ?? `models/${model.handle}/source`
  const listing = await r2.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix + '/' }))
  const keys = (listing.Contents ?? []).map(o => o.Key!).filter(Boolean).slice(0, 25)
  if (keys.length === 0) throw new Error(`No source photos at R2 prefix: ${prefix}`)

  const kieUrls: string[] = []
  for (const key of keys) {
    const filename = path.basename(key)
    const rawPath = path.join(tmpDir, `raw_${filename}`)
    const compPath = path.join(tmpDir, `comp_${path.parse(filename).name}.jpg`)
    await downloadFromR2(key, rawPath)
    await compressTo1024(rawPath, compPath)
    try {
      const url = await uploadFileToKie(compPath, path.basename(compPath), `pipeline/${model.handle}`)
      kieUrls.push(url)
      await sleep(600)
    } catch (e) {
      console.error(`  ✗ Upload failed for ${filename}:`, (e as Error).message)
    }
  }
  if (kieUrls.length < 3) throw new Error(`Too few photos uploaded to kie.ai (${kieUrls.length})`)

  const taskId = await createImageTask(CHARACTER_SHEET_PROMPT, kieUrls, '16:9')
  await updateModelSheetPolling(model.id, taskId)
  console.log(`  ✓ Character sheet task created: ${taskId}`)
}

/**
 * Phase 2 of async sheet generation: check kie.ai task status once.
 * On success: downloads result, uploads to R2, clears sheet_status.
 * On failure: sets sheet_status='error'. On pending: does nothing (call again later).
 */
export async function checkCharacterSheetTask(model: PipelineModel): Promise<void> {
  if (!model.sheet_kie_task_id) throw new Error('No kie task ID stored')

  const kieKey = process.env.KIE_API_KEY
  if (!kieKey) throw new Error('KIE_API_KEY not set')

  const res = await fetch(
    `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(model.sheet_kie_task_id)}`,
    { headers: { Authorization: `Bearer ${kieKey}` } }
  )
  const json = await res.json() as { code: number; data?: { state?: string; resultJson?: string; failMsg?: string } }
  if (json.code !== 200 || !json.data) return

  const { state, resultJson, failMsg } = json.data
  if (state === 'success') {
    const result = JSON.parse(resultJson ?? '{}')
    const url = (result.resultUrls ?? result.result_urls ?? [])[0] as string | undefined
    if (!url) throw new Error('Task succeeded but no URL in resultJson')

    const buf = await fetch(url).then(r => r.arrayBuffer())
    const sheetKey = `models/${model.handle}/reference/character_sheet.jpg`
    await uploadToR2(sheetKey, Buffer.from(new Uint8Array(buf)), 'image/jpeg')
    await updateModelCharacterSheet(model.id, sheetKey)
    console.log(`  ✓ Character sheet done for @${model.handle}`)
  } else if (state === 'fail') {
    await updateModelSheetStatus(model.id, 'error')
    console.error(`  ✗ Character sheet task failed for @${model.handle}: ${failMsg ?? 'unknown'}`)
  }
  // state === 'processing' | 'queuing' → do nothing, check again on next cron tick
}

/**
 * Returns a signed URL array for the character sheet reference.
 *
 * Priority:
 * 1. pinned_character_sheet_key — use as-is, no expiry check, no regeneration
 * 2. character_sheet_r2_key     — reuse existing sheet (no TTL check)
 * 3. Generate a new character sheet from source photos
 */
async function getCharacterSheetRef(model: PipelineModel): Promise<string[]> {
  let sheetKey: string

  if (model.pinned_character_sheet_key) {
    console.log(`  Using pinned character sheet: ${model.pinned_character_sheet_key}`)
    sheetKey = model.pinned_character_sheet_key
  } else if (model.character_sheet_r2_key) {
    console.log(`  Character sheet found, reusing: ${model.character_sheet_r2_key}`)
    sheetKey = model.character_sheet_r2_key
  } else {
    console.log('  No character sheet found, generating...')
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `kie_sheet_`))
    try {
      sheetKey = await generateCharacterSheet(model, tmpDir)
      // Update in-memory model so the rest of this run uses the fresh key
      model.character_sheet_r2_key = sheetKey
      model.character_sheet_generated_at = new Date().toISOString()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // Signed URL with 6h TTL — enough for one full generation cycle
  const signedUrl = await getSignedVideoUrl(sheetKey, 6 * 3600)
  return [signedUrl]
}

// ─── Image generation ─────────────────────────────────────────────────────────

function buildImagePrompt(brief: Brief, model: PipelineModel): string {
  const niche = model.niche_tags.slice(0, 3).join(', ')

  // SOP: close-ups outperform wide shots; face must be clearly visible
  const framings = [
    'close-up portrait, face centered, filling upper two-thirds of frame',
    'half-body shot, face clearly visible in upper half of frame',
    'tight close-up, eyes and expression dominant in frame',
  ]
  const framing = framings[(brief.slot - 1) % framings.length]

  // SOP: pink and orange are the two least-used colors in advertising.
  // Brief's color_hint overrides the rotation when the research phase picked a specific direction.
  const colorFallbacks = [
    'warm pink ambient lighting',
    'orange-tinted golden lighting',
    'peachy warm backlight',
  ]
  const colorHint = brief.color_hint ?? colorFallbacks[(brief.slot - 1) % colorFallbacks.length]

  // Component alteration: location and props from the brief drive visual diversity across slots
  const locationStr = brief.location ? `Setting: ${brief.location}.` : ''
  const propsStr = brief.props ? `Visible props in frame: ${brief.props}.` : ''

  return `Ultra-realistic photograph. ${niche} woman. ${framing}. ${locationStr} ${propsStr} Face clearly visible, natural expression, eyes open and expressive. ${colorHint}. Confident, sensual energy. Sharp focus on face. 9:16 vertical portrait. ${brief.concept}. No text overlays, no watermarks.`.replace(/\s+/g, ' ').trim()
}

async function generateImageVariants(
  brief: Brief,
  model: PipelineModel,
  kieRefs: string[],
  runId: string,
  videoId: string,
  tmpDir: string
): Promise<{ url: string; score: number; localPath: string }[]> {
  const prompt = buildImagePrompt(brief, model)

  let taskId: string
  try {
    taskId = await createImageTask(prompt, kieRefs)
  } catch (e) {
    console.error(`  [slot ${brief.slot}] ✗ Image task create failed:`, (e as Error).message)
    return []
  }

  try {
    const url = await pollTask(taskId, 6 * 60 * 1000)
    const localPath = path.join(tmpDir, `slot${brief.slot}_img1.jpg`)
    const buf = await fetch(url).then(r => r.arrayBuffer())
    fs.writeFileSync(localPath, Buffer.from(new Uint8Array(buf)))
    const r2Key = `models/${model.handle}/generated/${runId}/slot_${brief.slot}/img_1.jpg`
    await uploadToR2(r2Key, fs.readFileSync(localPath), 'image/jpeg')
    const score = await scoreImage(localPath, true)
    console.log(`  [slot ${brief.slot}] img score=${score}`)
    await saveVariants(videoId, 'image', [{ r2_key: r2Key, score, idx: 1 }]).catch(() => {})
    return [{ url, score, localPath }]
  } catch (e) {
    console.error(`  [slot ${brief.slot}] ✗ Image poll/upload failed:`, (e as Error).message)
    return []
  }
}

// ─── Video generation ─────────────────────────────────────────────────────────

const VIDEO_MOTION_PROMPT = 'slow natural head turn, gentle breathing, subtle body sway, no sudden movements, no talking, eyes expressive, loopable ending, cinematic motion'

async function generateVideoVariants(
  brief: Brief,
  model: PipelineModel,
  bestImageUrl: string,
  runId: string,
  videoId: string,
  tmpDir: string
): Promise<{ url: string; localPath: string; r2Key: string; idx: number }[]> {
  let taskId: string
  try {
    taskId = await createVideoTask(VIDEO_MOTION_PROMPT, bestImageUrl)
  } catch (e) {
    console.error(`  [slot ${brief.slot}] ✗ Video task create failed:`, (e as Error).message)
    return []
  }

  try {
    const url = await pollTask(taskId, 12 * 60 * 1000)
    const localPath = path.join(tmpDir, `slot${brief.slot}_vid1.mp4`)
    const buf = await fetch(url).then(r => r.arrayBuffer())
    fs.writeFileSync(localPath, Buffer.from(new Uint8Array(buf)))
    const r2Key = `models/${model.handle}/generated/${runId}/slot_${brief.slot}/vid_1.mp4`
    await uploadToR2(r2Key, fs.readFileSync(localPath), 'video/mp4')
    console.log(`  [slot ${brief.slot}] vid done`)
    await saveVariants(videoId, 'video', [{ r2_key: r2Key, idx: 1 }]).catch(() => {})
    return [{ url, localPath, r2Key, idx: 1 }]
  } catch (e) {
    console.error(`  [slot ${brief.slot}] ✗ Video poll/upload failed:`, (e as Error).message)
    return []
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function generateVideos(
  model: PipelineModel,
  briefs: Brief[],
  runId: string
): Promise<void> {
  const slotsExpected = model.videos_per_cycle ?? 6
  console.log(`[generate] Starting generation for @${model.handle}, run ${runId} (${slotsExpected} slots expected)`)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pipeline_gen_`))

  try {
    // Get character sheet reference (generate only if none exists)
    const kieRefs = await getCharacterSheetRef(model)

    // All slots run in parallel — total time ≈ slowest single slot (~8 min), not N×slot
    await Promise.all(briefs.map(async (brief) => {
      console.log(`\n  [Slot ${brief.slot}/${slotsExpected}] "${brief.overlay_text}"`)

      const videoId = await createVideo(runId, brief.slot, brief, brief.source_post_id)

      const imageVariants = await generateImageVariants(brief, model, kieRefs, runId, videoId, tmpDir)
      if (imageVariants.length === 0) {
        console.error(`  [slot ${brief.slot}] ✗ No image — skipping slot`)
        await updateVideo(videoId, { status: 'rejected' })
        return
      }

      const bestImage = imageVariants[0]
      console.log(`  [slot ${brief.slot}] image score: ${bestImage.score}`)

      const videoVariants = await generateVideoVariants(brief, model, bestImage.url, runId, videoId, tmpDir)
      if (videoVariants.length === 0) {
        console.error(`  [slot ${brief.slot}] ✗ No video — skipping slot`)
        await updateVideo(videoId, { status: 'rejected' })
        return
      }

      const bestVideo = videoVariants[0]

      await updateVideo(videoId, {
        status: 'pending',
        final_r2_key: bestVideo.r2Key,
      })

      console.log(`  [slot ${brief.slot}] ✓ done`)
    }))
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
