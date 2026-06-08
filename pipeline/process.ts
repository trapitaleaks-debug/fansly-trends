/**
 * Phase 4 — Post-Processing (ffmpeg)
 * Burns text overlay + audio onto generated raw videos, generates thumbnails.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import { uploadToR2, r2 } from '../lib/r2'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getRunVideos, updateVideo, type PipelineModel, type PipelineVideo } from './db'
import { scoreVideo } from './score-video'
import { supabaseAdmin } from '../lib/supabase'

const BUCKET = process.env.R2_BUCKET_NAME ?? 'fansly-trends'
const FONT = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
const FONT_MAC = '/System/Library/Fonts/Helvetica.ttc'

function ffmpegBin() {
  return process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg'
}
function fontPath() {
  return process.platform === 'darwin' ? FONT_MAC : FONT
}

function run(cmd: string) {
  execSync(cmd, { stdio: 'pipe', env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` } })
}

async function downloadFromR2(key: string, destPath: string): Promise<void> {
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  const body = res.Body
  if (!body) throw new Error(`R2 key not found: ${key}`)
  const chunks: Uint8Array[] = []
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk)
  fs.writeFileSync(destPath, Buffer.concat(chunks))
}

function escapeDrawtext(text: string): string {
  // ffmpeg drawtext special chars: : \ ' ( )
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "'\\''")
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
}

function buildDrawtextFilter(overlayText: string): string {
  const font = fontPath()
  const MAX_CHARS = 40

  if (overlayText.length <= MAX_CHARS) {
    const escaped = escapeDrawtext(overlayText)
    return `drawtext=text='${escaped}':fontfile='${font}':fontsize=52:fontcolor=white:x=(w-text_w)/2:y=h*0.20:box=1:boxcolor=black@0.55:boxborderw=18`
  }

  // Split into two lines at nearest word boundary
  const mid = Math.floor(overlayText.length / 2)
  let splitIdx = mid
  for (let i = mid; i < overlayText.length; i++) {
    if (overlayText[i] === ' ') { splitIdx = i; break }
  }
  for (let i = mid; i >= 0; i--) {
    if (overlayText[i] === ' ') { splitIdx = i; break }
  }

  const line1 = escapeDrawtext(overlayText.slice(0, splitIdx).trim())
  const line2 = escapeDrawtext(overlayText.slice(splitIdx).trim())

  const filter1 = `drawtext=text='${line1}':fontfile='${font}':fontsize=52:fontcolor=white:x=(w-text_w)/2:y=h*0.18:box=1:boxcolor=black@0.55:boxborderw=18`
  const filter2 = `drawtext=text='${line2}':fontfile='${font}':fontsize=52:fontcolor=white:x=(w-text_w)/2:y=h*0.26:box=1:boxcolor=black@0.55:boxborderw=18`

  return `${filter1},${filter2}`
}

// Maps hook descriptions to R2 clip keys — user uploads clips under hooks/ prefix
const HOOK_R2_KEYS: Record<string, string> = {
  sports: 'hooks/sports.mp4',
  baseball: 'hooks/sports.mp4',
  ball: 'hooks/sports.mp4',
  explosion: 'hooks/explosion.mp4',
  fire: 'hooks/explosion.mp4',
  jumpscare: 'hooks/jumpscare.mp4',
  'jump scare': 'hooks/jumpscare.mp4',
  scare: 'hooks/jumpscare.mp4',
  animal: 'hooks/animal.mp4',
  dog: 'hooks/animal.mp4',
  cat: 'hooks/animal.mp4',
  pet: 'hooks/animal.mp4',
}

function matchHookKey(hookDescription: string): string {
  const desc = hookDescription.toLowerCase()
  for (const [kw, key] of Object.entries(HOOK_R2_KEYS)) {
    if (desc.includes(kw)) return key
  }
  return 'hooks/general.mp4'
}

/**
 * Returns the R2 key for a hook clip.
 * Checks model's content bank (type='hook_clip') first; falls back to global HOOK_R2_KEYS.
 */
async function getModelHookKey(model: PipelineModel, hookDescription: string): Promise<string> {
  try {
    const { data } = await supabaseAdmin
      .from('pipeline_content_bank')
      .select('r2_key')
      .eq('model_id', model.id)
      .eq('type', 'hook_clip')
      .limit(1)
      .single()

    if (data?.r2_key) {
      console.log(`  Using model-specific hook clip: ${data.r2_key}`)
      return data.r2_key
    }
  } catch {
    // No model-specific hook clip found — fall through to global
  }

  return matchHookKey(hookDescription)
}

/** For flashing format: extract near-end frame, boost it, append 5 frames at end */
async function addFlashFrame(finalPath: string, duration: number, tmpDir: string, slot: number): Promise<void> {
  const flashTime = Math.max(0, duration - 1.2)
  const flashJpeg = path.join(tmpDir, `s${slot}_flash.jpg`)
  const flashMp4 = path.join(tmpDir, `s${slot}_flash.mp4`)
  const withFlash = path.join(tmpDir, `s${slot}_with_flash.mp4`)
  const concatTxt = path.join(tmpDir, `s${slot}_concat.txt`)

  run(`${ffmpegBin()} -i "${finalPath}" -ss ${flashTime.toFixed(2)} -vframes 1 -vf "eq=brightness=0.18:contrast=1.35:saturation=1.2" -y "${flashJpeg}"`)
  run(`${ffmpegBin()} -loop 1 -i "${flashJpeg}" -t 0.17 -r 30 -c:v libx264 -preset ultrafast -threads 2 -pix_fmt yuv420p -y "${flashMp4}"`)

  fs.writeFileSync(concatTxt, `file '${finalPath}'\nfile '${flashMp4}'\n`)
  run(`${ffmpegBin()} -f concat -safe 0 -i "${concatTxt}" -c:v libx264 -preset ultrafast -threads 2 -c:a aac -y "${withFlash}"`)
  fs.renameSync(withFlash, finalPath)
}

/** For viral_hook format: download hook clip from R2 and prepend to video */
async function prependHookClip(
  hookDescription: string,
  finalPath: string,
  tmpDir: string,
  slot: number,
  model: PipelineModel
): Promise<void> {
  const hookKey = await getModelHookKey(model, hookDescription)
  const hookRaw = path.join(tmpDir, `s${slot}_hook_raw.mp4`)
  const hookNorm = path.join(tmpDir, `s${slot}_hook_norm.mp4`)
  const withHook = path.join(tmpDir, `s${slot}_with_hook.mp4`)

  try {
    await downloadFromR2(hookKey, hookRaw)
  } catch {
    console.log(`  ℹ Hook clip not found in R2 (${hookKey}) — upload clips to R2 hooks/ prefix to enable this`)
    return
  }

  // Normalize hook to 720p 9:16, max 3s, no audio
  run(
    `${ffmpegBin()} -i "${hookRaw}" -t 3 ` +
    `-vf "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30" ` +
    `-c:v libx264 -preset ultrafast -threads 2 -an -y "${hookNorm}"`
  )

  // Concat: hook (video only) + main (video + audio)
  run(
    `${ffmpegBin()} -i "${hookNorm}" -i "${finalPath}" ` +
    `-filter_complex "[0:v][1:v]concat=n=2:v=1:a=0[v]" ` +
    `-map "[v]" -map "1:a?" -c:v libx264 -preset ultrafast -threads 2 -c:a aac -y "${withHook}"`
  )
  fs.renameSync(withHook, finalPath)
  console.log(`  Hook clip prepended from R2 (${hookKey})`)
}

async function processVideo(video: PipelineVideo, tmpDir: string, handle: string, model: PipelineModel): Promise<void> {
  if (!video.final_r2_key || !video.brief) {
    throw new Error(`Video ${video.id} missing r2 key or brief`)
  }

  const overlayText = video.brief.overlay_text
  const sourcePostId = video.source_post_id

  const rawPath = path.join(tmpDir, `slot${video.slot}_raw.mp4`)
  const audioPath = path.join(tmpDir, `slot${video.slot}_audio.aac`)
  const finalPath = path.join(tmpDir, `slot${video.slot}_final.mp4`)
  const thumbPath = path.join(tmpDir, `slot${video.slot}_thumb.jpg`)

  // Download raw generated video
  console.log(`  Downloading raw video...`)
  await downloadFromR2(video.final_r2_key, rawPath)

  // Get video duration
  const durationOut = execSync(
    `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${rawPath}"`,
    { env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` } }
  ).toString().trim()
  const duration = parseFloat(durationOut) || 7

  // Extract audio from source trending video
  let hasAudio = false
  if (sourcePostId) {
    try {
      const sourceKey = `videos/${sourcePostId}.mp4`
      const sourcePath = path.join(tmpDir, `source_${video.slot}.mp4`)
      await downloadFromR2(sourceKey, sourcePath)
      run(
        `${ffmpegBin()} -i "${sourcePath}" -t ${duration.toFixed(2)} -vn -acodec aac ` +
        `-af "afade=t=in:ss=0:d=0.2,afade=t=out:st=${Math.max(0, duration - 0.3).toFixed(2)}:d=0.3" ` +
        `-y "${audioPath}"`
      )
      hasAudio = fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000
    } catch {
      console.log('  Source video not in R2, skipping audio')
    }
  }

  // Burn overlay + merge audio
  const drawtextFilter = buildDrawtextFilter(overlayText)
  // preset ultrafast + threads 2 keeps RAM under Railway's container limit (~512MB)
  const encodeFlags = `-c:v libx264 -preset ultrafast -threads 2 -crf 23`
  const ffmpegCmd = hasAudio
    ? `${ffmpegBin()} -i "${rawPath}" -i "${audioPath}" -vf "${drawtextFilter}" ${encodeFlags} -c:a aac -shortest -y "${finalPath}"`
    : `${ffmpegBin()} -i "${rawPath}" -vf "${drawtextFilter}" ${encodeFlags} -an -y "${finalPath}"`

  console.log(`  Burning overlay: "${overlayText}"`)
  run(ffmpegCmd)

  // Format-specific post-processing
  const contentFormat = video.brief?.content_format
  if (contentFormat === 'flashing' && model.flash_frame_enabled === true) {
    console.log('  Adding flash frame (flashing format, flash_frame_enabled=true)...')
    await addFlashFrame(finalPath, duration, tmpDir, video.slot)
  } else if (contentFormat === 'viral_hook' && video.brief?.hook_description) {
    await prependHookClip(video.brief.hook_description, finalPath, tmpDir, video.slot, model)
  }

  // Generate thumbnail at 1s
  run(`${ffmpegBin()} -i "${finalPath}" -ss 00:00:01 -vframes 1 -y "${thumbPath}"`)

  // Score video quality — informational only, never auto-reject
  console.log('  Scoring video quality...')
  const scores = await scoreVideo(thumbPath, overlayText, contentFormat ?? 'text_overlay')
  console.log(`  Quality: AI ${scores.ai_quality}/10 · Total ${scores.total}/90`)

  // Upload final video + thumbnail to R2
  const runId = video.run_id
  const finalKey = `models/${handle}/final/${runId}/slot_${video.slot}.mp4`
  const thumbKey = `models/${handle}/final/${runId}/slot_${video.slot}_thumb.jpg`

  await uploadToR2(finalKey, fs.readFileSync(finalPath), 'video/mp4')
  await uploadToR2(thumbKey, fs.readFileSync(thumbPath), 'image/jpeg')

  // Store quality scores in brief JSONB (no migration needed)
  const updatedBrief = video.brief ? { ...video.brief, quality_scores: scores } : video.brief

  // Retry up to 3 times for transient network errors
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await updateVideo(video.id, {
        final_r2_key: finalKey,
        thumbnail_r2_key: thumbKey,
        status: 'ready',
        brief: updatedBrief,
      })
      break
    } catch (e) {
      if (attempt === 3) throw e
      await new Promise(r => setTimeout(r, 2000 * attempt))
    }
  }

  console.log(`  ✓ Slot ${video.slot} processed — ${finalKey}`)
}

export async function processRun(runId: string, handle: string, model: PipelineModel): Promise<void> {
  console.log(`[process] Processing run ${runId} for @${handle}`)
  const videos = await getRunVideos(runId)
  const pending = videos.filter(v => v.status === 'pending' && v.final_r2_key)

  console.log(`  ${pending.length} videos to process`)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pipeline_proc_`))

  try {
    for (const video of pending) {
      console.log(`\n  [Slot ${video.slot}] "${video.brief?.overlay_text}"`)
      try {
        await processVideo(video, tmpDir, handle, model)
      } catch (e) {
        console.error(`  ✗ Slot ${video.slot} failed:`, (e as Error).message)
        await updateVideo(video.id, { status: 'rejected' })
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log(`\n[process] Done — ${pending.length} videos processed`)
}
