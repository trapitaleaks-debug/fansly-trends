/**
 * Video job renderer — processes video_jobs table rows.
 * Takes own footage from model_clips + personalized_text overlay,
 * renders via Hyperframes (Linux/Railway) or ffmpeg drawtext (Mac dev),
 * optionally extracts audio from the trending post's source video.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import { uploadToR2, r2 } from '../lib/r2'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { supabaseAdmin } from '../lib/supabase'
import { type BrandConfig } from './compose'

const BUCKET = process.env.R2_BUCKET_NAME ?? 'fansly-trends'
const FONT = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
const FONT_MAC = '/System/Library/Fonts/Helvetica.ttc'

function ffmpegBin() {
  return process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg'
}
function fontPath() {
  return process.platform === 'darwin' ? FONT_MAC : FONT
}
function hyperframesBin() {
  return path.resolve(__dirname, '../node_modules/.bin/hyperframes')
}

function run(cmd: string) {
  try {
    execSync(cmd, { stdio: 'pipe', env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` } })
  } catch (e) {
    const err = e as Error & { stderr?: Buffer; stdout?: Buffer }
    const stderr = err.stderr?.toString().trim()
    if (stderr) console.error(`  [cmd stderr] ${stderr.slice(0, 600)}`)
    throw e
  }
}

async function downloadFromR2(key: string, destPath: string): Promise<void> {
  const buf = await downloadBufferFromR2(key)
  fs.writeFileSync(destPath, buf)
}

async function downloadBufferFromR2(key: string): Promise<Buffer> {
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  const body = res.Body
  if (!body) throw new Error(`R2 key not found: ${key}`)
  const chunks: Uint8Array[] = []
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function stripEmoji(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}(?:️?(?:‍\p{Extended_Pictographic}️?)*)?️?/gu, '')
    .replace(/‍/g, '')        // stray zero-width joiners
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '') // stray variation selectors
    .replace(/\s+/g, ' ')
    .trim()
}

function buildDrawtextFilter(overlayText: string, tmpDir: string): string {
  const font = fontPath()
  const MAX_CHARS = 40
  const baseStyle = `fontfile='${font}':fontsize=70:fontcolor=white:bordercolor=black:borderw=6`
  const safeText = stripEmoji(overlayText)
  if (!safeText) return ''

  if (safeText.length <= MAX_CHARS) {
    const textFile = path.join(tmpDir, 'text_1.txt')
    fs.writeFileSync(textFile, safeText, 'utf8')
    return `drawtext=textfile='${textFile}':${baseStyle}:x=(w-text_w)/2:y=h*0.70`
  }

  const mid = Math.floor(safeText.length / 2)
  let splitIdx = mid
  for (let i = mid; i < safeText.length; i++) { if (safeText[i] === ' ') { splitIdx = i; break } }
  for (let i = mid; i >= 0; i--) { if (safeText[i] === ' ') { splitIdx = i; break } }

  const line1 = safeText.slice(0, splitIdx).trim()
  const line2 = safeText.slice(splitIdx).trim()
  const textFile1 = path.join(tmpDir, 'text_1.txt')
  const textFile2 = path.join(tmpDir, 'text_2.txt')
  fs.writeFileSync(textFile1, line1, 'utf8')
  fs.writeFileSync(textFile2, line2, 'utf8')
  return `drawtext=textfile='${textFile1}':${baseStyle}:x=(w-text_w)/2:y=h*0.65,drawtext=textfile='${textFile2}':${baseStyle}:x=(w-text_w)/2:y=h*0.73`
}


export async function processVideoJob(jobId: string): Promise<void> {
  console.log(`[job] Processing video_job ${jobId}`)

  // Load job with related data
  const { data: job, error: jobErr } = await supabaseAdmin
    .from('video_jobs')
    .select(`
      id, post_id, model_id, clip_id, personalized_text, status, duration_seconds,
      model_clips ( r2_key ),
      trends_models ( fansly_username, brand_html_r2_key, video_brand_config ),
      trends_posts ( video_r2_key, fansly_post_id )
    `)
    .eq('id', jobId)
    .single()

  if (jobErr || !job) throw new Error(`Job not found: ${jobErr?.message}`)
  if (job.status !== 'pending') {
    console.log(`[job] ${jobId} is already ${job.status}, skipping`)
    return
  }

  // Mark as processing immediately to avoid duplicate pickup
  await supabaseAdmin.from('video_jobs').update({ status: 'processing' }).eq('id', jobId)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vj_'))

  try {
    const clipKey = (job.model_clips as unknown as { r2_key: string } | null)?.r2_key
    if (!clipKey) throw new Error('No footage clip attached to this job')

    const modelMeta = job.trends_models as unknown as { fansly_username: string; brand_html_r2_key: string | null; video_brand_config: BrandConfig | null } | null
    const handle = modelMeta?.fansly_username ?? 'unknown'
    const brandHtmlKey = modelMeta?.brand_html_r2_key ?? null
    const brandConfig = modelMeta?.video_brand_config ?? null
    const overlayText = job.personalized_text ?? ''
    const sourceVideoKey = (job.trends_posts as unknown as { video_r2_key: string | null } | null)?.video_r2_key

    const rawPath = path.join(tmpDir, 'raw.mp4')
    const audioPath = path.join(tmpDir, 'audio.aac')
    const finalPath = path.join(tmpDir, 'final.mp4')
    const thumbPath = path.join(tmpDir, 'thumb.jpg')

    // 1. Download own footage
    console.log(`  Downloading footage: ${clipKey}`)
    await downloadFromR2(clipKey, rawPath)

    // Look up trim points from content bank (trim is applied by ffmpeg, not during upload)
    const { data: bankItem } = await supabaseAdmin
      .from('pipeline_content_bank')
      .select('trim_start, trim_end')
      .eq('r2_key', clipKey)
      .maybeSingle()
    const trimStart = bankItem?.trim_start ?? 0
    const trimEnd = bankItem?.trim_end ?? null
    const requestedDuration: number = (job as unknown as { duration_seconds?: number }).duration_seconds ?? 5

    // 2. Get duration — probe format first, then video stream (WebM from MediaRecorder often lacks format duration)
    let fullDuration = 0
    try {
      const fmtDur = execSync(
        `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${rawPath}"`,
        { env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` } }
      ).toString().trim()
      fullDuration = parseFloat(fmtDur) || 0
    } catch { /* ignore */ }
    if (!fullDuration || fullDuration < 0.1) {
      try {
        const strmDur = execSync(
          `ffprobe -v quiet -select_streams v:0 -show_entries stream=duration -of csv=p=0 "${rawPath}"`,
          { env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` } }
        ).toString().trim()
        fullDuration = parseFloat(strmDur) || 15
      } catch { fullDuration = 15 }
    }
    const clipDuration = trimEnd != null ? trimEnd - trimStart : fullDuration - trimStart
    // Cap output to the user-requested duration; never exceed actual clip length
    const duration = Math.min(requestedDuration, clipDuration)

    // 3. Try to extract audio from trending post's source video
    let hasAudio = false
    if (sourceVideoKey) {
      try {
        const sourcePath = path.join(tmpDir, 'source.mp4')
        await downloadFromR2(sourceVideoKey, sourcePath)
        run(
          `${ffmpegBin()} -i "${sourcePath}" -t ${duration.toFixed(2)} -vn -acodec aac ` +
          `-af "afade=t=in:ss=0:d=0.2,afade=t=out:st=${Math.max(0, duration - 0.3).toFixed(2)}:d=0.3" ` +
          `-y "${audioPath}"`
        )
        hasAudio = fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000
        console.log(`  Audio extracted from source video`)
      } catch {
        console.log(`  Source video not available — no audio`)
      }
    }

    // 4. Render text overlay
    // -preset fast: much better quality than ultrafast with acceptable speed on Railway
    // -crf 20: higher quality (lower = better, 23 was too lossy for source footage)
    // -pix_fmt yuv420p: standardise pixel format to prevent color range shifts during encode
    // -r 30: force constant 30fps output — phones shoot VFR which causes stuttering
    // -movflags +faststart: move MOOV atom to front for fast web playback
    const encodeFlags = `-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -r 30 -movflags +faststart`
    console.log(`  Rendering overlay: "${overlayText}"`)

    const dtFilter = overlayText.trim() ? buildDrawtextFilter(overlayText, tmpDir) : null
    const vf = dtFilter ? `-vf "${dtFilter}"` : ''
    // -ss before -i = fast input seek; -t always applied — duration already capped by requestedDuration
    const seekFlag = trimStart > 0 ? `-ss ${trimStart.toFixed(3)}` : ''
    const durFlag = `-t ${duration.toFixed(3)}`
    const rawInput = `${seekFlag} -i "${rawPath}" ${durFlag}`
    const videoIn = hasAudio ? `${ffmpegBin()} ${rawInput} -i "${audioPath}"` : `${ffmpegBin()} ${rawInput}`
    const audioMap = hasAudio ? `-c:a aac -shortest` : `-an`
    run(`${videoIn} ${vf} ${encodeFlags} ${audioMap} -y "${finalPath}"`)

    // 5. Thumbnail at 1s
    run(`${ffmpegBin()} -i "${finalPath}" -ss 00:00:01 -vframes 1 -y "${thumbPath}"`)

    // 6. Upload to R2
    const outputKey = `video-jobs/${jobId}/output.mp4`
    const thumbKey = `video-jobs/${jobId}/thumb.jpg`
    await uploadToR2(outputKey, fs.readFileSync(finalPath), 'video/mp4')
    await uploadToR2(thumbKey, fs.readFileSync(thumbPath), 'image/jpeg')

    // 7. Mark done
    await supabaseAdmin.from('video_jobs').update({
      status: 'done',
      output_r2_key: outputKey,
      thumbnail_r2_key: thumbKey,
    }).eq('id', jobId)

    console.log(`[job] ✓ Done — ${outputKey}`)
  } catch (e) {
    const msg = (e as Error).message
    console.error(`[job] ✗ Failed ${jobId}:`, msg)
    await supabaseAdmin.from('video_jobs').update({
      status: 'error',
      error_message: msg.slice(0, 500),
    }).eq('id', jobId)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
