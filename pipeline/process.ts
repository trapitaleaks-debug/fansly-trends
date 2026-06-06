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
import { getRunVideos, updateVideo, type PipelineVideo } from './db'

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

async function processVideo(video: PipelineVideo, tmpDir: string, handle: string): Promise<void> {
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
      console.log('  ⚠ Source video not in R2, skipping audio')
    }
  }

  // Burn overlay + merge audio
  const drawtextFilter = buildDrawtextFilter(overlayText)
  const ffmpegCmd = hasAudio
    ? `${ffmpegBin()} -i "${rawPath}" -i "${audioPath}" -vf "${drawtextFilter}" -c:v libx264 -c:a aac -shortest -y "${finalPath}"`
    : `${ffmpegBin()} -i "${rawPath}" -vf "${drawtextFilter}" -c:v libx264 -an -y "${finalPath}"`

  console.log(`  Burning overlay: "${overlayText}"`)
  run(ffmpegCmd)

  // Generate thumbnail at 1s
  run(`${ffmpegBin()} -i "${finalPath}" -ss 00:00:01 -vframes 1 -y "${thumbPath}"`)

  // Upload final video + thumbnail to R2
  const runId = video.run_id
  const finalKey = `models/${handle}/final/${runId}/slot_${video.slot}.mp4`
  const thumbKey = `models/${handle}/final/${runId}/slot_${video.slot}_thumb.jpg`

  await uploadToR2(finalKey, fs.readFileSync(finalPath), 'video/mp4')
  await uploadToR2(thumbKey, fs.readFileSync(thumbPath), 'image/jpeg')

  // Retry up to 3 times for transient network errors
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await updateVideo(video.id, { final_r2_key: finalKey, thumbnail_r2_key: thumbKey, status: 'pending' })
      break
    } catch (e) {
      if (attempt === 3) throw e
      await new Promise(r => setTimeout(r, 2000 * attempt))
    }
  }

  console.log(`  ✓ Slot ${video.slot} processed — ${finalKey}`)
}

export async function processRun(runId: string, handle: string): Promise<void> {
  console.log(`[process] Processing run ${runId} for @${handle}`)
  const videos = await getRunVideos(runId)
  const pending = videos.filter(v => v.status === 'pending' && v.final_r2_key)

  console.log(`  ${pending.length} videos to process`)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pipeline_proc_`))

  try {
    for (const video of pending) {
      console.log(`\n  [Slot ${video.slot}] "${video.brief?.overlay_text}"`)
      try {
        await processVideo(video, tmpDir, handle)
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
