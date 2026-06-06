/**
 * Phase 3 — Generation Engine
 * For each brief: generate 4 image variants → score → generate 4 video variants → score → save best
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import Anthropic from '@anthropic-ai/sdk'
import { uploadToR2, r2 } from '../lib/r2'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { createImageTask, createVideoTask, pollTask, uploadFileToKie, sleep } from './kie'
import { getModel, createVideo, updateVideo, updateModelKieRefs, type PipelineModel, type Brief } from './db'

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

// ─── Reference photo re-upload ────────────────────────────────────────────────

async function refreshKieRefs(model: PipelineModel): Promise<string[]> {
  const uploadedAt = model.kie_ref_uploaded_at ? new Date(model.kie_ref_uploaded_at) : null
  const ageMs = uploadedAt ? Date.now() - uploadedAt.getTime() : Infinity
  const TWO_AND_HALF_DAYS = 2.5 * 24 * 60 * 60 * 1000

  if (ageMs < TWO_AND_HALF_DAYS && model.kie_ref_urls.length > 0) {
    console.log(`  kie.ai refs valid (age ${Math.round(ageMs / 3600000)}h), reusing`)
    return model.kie_ref_urls
  }

  console.log('  kie.ai refs expired, re-uploading from R2...')
  const prefix = model.source_photos_r2_prefix ?? `models/${model.handle}/source`
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `kie_refs_`))

  // List source files from R2
  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3')
  const listing = await r2.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix + '/' }))
  const keys = (listing.Contents ?? []).map(o => o.Key!).filter(Boolean).slice(0, 15)

  if (keys.length === 0) throw new Error(`No source photos found at R2 prefix: ${prefix}`)

  const newUrls: string[] = []
  for (const key of keys) {
    const filename = path.basename(key)
    const localPath = path.join(tmpDir, filename)
    await downloadFromR2(key, localPath)
    try {
      const url = await uploadFileToKie(localPath, filename, `pipeline/${model.handle}`)
      newUrls.push(url)
      await sleep(600)
    } catch (e) {
      console.error(`  ✗ Re-upload failed for ${filename}:`, (e as Error).message)
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true })

  if (newUrls.length < 3) throw new Error('Not enough kie.ai ref uploads succeeded')
  await updateModelKieRefs(model.id, newUrls)
  console.log(`  Re-uploaded ${newUrls.length} refs to kie.ai`)
  return newUrls
}

// ─── Image generation ─────────────────────────────────────────────────────────

function buildImagePrompt(brief: Brief, model: PipelineModel): string {
  const niche = model.niche_tags.slice(0, 3).join(', ')
  return `Ultra-realistic photograph. ${niche} woman. Sensual, confident pose. Natural lighting, sharp focus. Professional photo quality. 9:16 vertical portrait. Context: ${brief.concept}. No watermarks, no text overlays.`
}

async function generateImageVariants(
  brief: Brief,
  model: PipelineModel,
  kieRefs: string[],
  runId: string,
  tmpDir: string
): Promise<{ url: string; score: number; localPath: string }[]> {
  const prompt = buildImagePrompt(brief, model)
  const taskIds: string[] = []

  for (let v = 0; v < 4; v++) {
    try {
      const taskId = await createImageTask(prompt, kieRefs)
      taskIds.push(taskId)
      await sleep(700)
    } catch (e) {
      console.error(`  ✗ Image task ${v + 1}/4 failed:`, (e as Error).message)
    }
  }

  // Poll all image tasks in parallel
  const settled = await Promise.allSettled(
    taskIds.map(async (taskId, i) => {
      const url = await pollTask(taskId, 6 * 60 * 1000)
      const localPath = path.join(tmpDir, `slot${brief.slot}_img${i + 1}.jpg`)
      const buf = await fetch(url).then(r => r.arrayBuffer())
      fs.writeFileSync(localPath, Buffer.from(new Uint8Array(buf)))
      const r2Key = `models/${model.handle}/generated/${runId}/slot_${brief.slot}/img_${i + 1}.jpg`
      await uploadToR2(r2Key, fs.readFileSync(localPath), 'image/jpeg')
      const score = await scoreImage(localPath, true)
      console.log(`    img ${i + 1}/4 score=${score}`)
      return { url, score, localPath }
    })
  )

  return settled
    .map((r, i) => {
      if (r.status === 'fulfilled') return r.value
      console.error(`  ✗ Image ${i + 1}/4 failed:`, (r as PromiseRejectedResult).reason?.message)
      return null
    })
    .filter((r): r is { url: string; score: number; localPath: string } => r !== null)
}

// ─── Video generation ─────────────────────────────────────────────────────────

const VIDEO_MOTION_PROMPT = 'slow natural head turn, gentle breathing, subtle body sway, no sudden movements, no talking, eyes expressive, loopable ending, cinematic motion'

async function generateVideoVariants(
  brief: Brief,
  model: PipelineModel,
  bestImageUrl: string,
  runId: string,
  tmpDir: string
): Promise<{ url: string; localPath: string }[]> {
  const taskIds: string[] = []

  for (let v = 0; v < 4; v++) {
    try {
      const taskId = await createVideoTask(VIDEO_MOTION_PROMPT, bestImageUrl)
      taskIds.push(taskId)
      await sleep(700)
    } catch (e) {
      console.error(`  ✗ Video task ${v + 1}/4 failed:`, (e as Error).message)
    }
  }

  // Poll all video tasks in parallel (they all start around the same time on kie.ai)
  const settled = await Promise.allSettled(
    taskIds.map(async (taskId, i) => {
      const url = await pollTask(taskId, 12 * 60 * 1000)
      const localPath = path.join(tmpDir, `slot${brief.slot}_vid${i + 1}.mp4`)
      const buf = await fetch(url).then(r => r.arrayBuffer())
      fs.writeFileSync(localPath, Buffer.from(new Uint8Array(buf)))
      const r2Key = `models/${model.handle}/generated/${runId}/slot_${brief.slot}/vid_${i + 1}.mp4`
      await uploadToR2(r2Key, fs.readFileSync(localPath), 'video/mp4')
      console.log(`    vid ${i + 1}/4 done`)
      return { url, localPath }
    })
  )

  const results = settled
    .map((r, i) => {
      if (r.status === 'fulfilled') return r.value
      console.error(`  ✗ Video ${i + 1}/4 failed:`, (r as PromiseRejectedResult).reason?.message)
      return null
    })
    .filter((r): r is { url: string; localPath: string } => r !== null)

  return results
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function generateVideos(
  model: PipelineModel,
  briefs: Brief[],
  runId: string
): Promise<void> {
  console.log(`[generate] Starting generation for @${model.handle}, run ${runId}`)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pipeline_gen_`))

  try {
    // Ensure kie.ai refs are fresh
    const kieRefs = await refreshKieRefs(model)

    for (const brief of briefs) {
      console.log(`\n  [Slot ${brief.slot}/6] "${brief.overlay_text}"`)

      const videoId = await createVideo(runId, brief.slot, brief, brief.source_post_id)

      // Generate images
      console.log('  Generating images...')
      const imageVariants = await generateImageVariants(brief, model, kieRefs, runId, tmpDir)

      if (imageVariants.length === 0) {
        console.error(`  ✗ No image variants for slot ${brief.slot}, skipping`)
        await updateVideo(videoId, { status: 'rejected' })
        continue
      }

      const bestImage = imageVariants.reduce((a, b) => a.score > b.score ? a : b)
      console.log(`  Best image score: ${bestImage.score}`)

      // Generate videos from best image
      console.log('  Generating videos...')
      const videoVariants = await generateVideoVariants(brief, model, bestImage.url, runId, tmpDir)

      if (videoVariants.length === 0) {
        console.error(`  ✗ No video variants for slot ${brief.slot}, skipping`)
        await updateVideo(videoId, { status: 'rejected' })
        continue
      }

      // Pick first successful video (all 7s, motion is similar)
      const bestVideo = videoVariants[0]

      // Upload best raw video to R2
      const rawKey = `models/${model.handle}/generated/${runId}/slot_${brief.slot}/best_raw.mp4`
      await uploadToR2(rawKey, fs.readFileSync(bestVideo.localPath), 'video/mp4')

      await updateVideo(videoId, {
        status: 'pending',
        final_r2_key: rawKey, // process.ts will overwrite with final (overlay+audio)
      })

      console.log(`  ✓ Slot ${brief.slot} done — raw video saved to R2`)
      await sleep(500)
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
