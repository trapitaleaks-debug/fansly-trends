/**
 * Video job renderer — processes video_jobs table rows.
 * Takes own footage from model_clips + personalized_text overlay,
 * renders via Remotion (React-based, word-stagger animation, emoji, per-brand fonts).
 * ffmpeg is retained for .mov normalization, footage scaling, audio extraction, and thumbnail.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import { uploadToR2, r2 } from '../lib/r2'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { supabaseAdmin } from '../lib/supabase'
import { type BrandConfig } from './compose'
import { renderWithRemotion } from './remotion-renderer'

const BUCKET = process.env.R2_BUCKET_NAME ?? 'fansly-trends'

function ffmpegBin() {
  return process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg'
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

    // Normalize .mov clips to clean H.264 MP4 — MOV container metadata (rotation, SAR,
    // color space, HEVC profile) causes libx264 to fail with "incorrect parameters" on Railway.
    // -t 60: only normalize the first 60s — raw iPhone footage can be multi-minute; we never use more than 15s.
    if (clipKey.toLowerCase().endsWith('.mov')) {
      const normPath = path.join(tmpDir, 'normalized.mp4')
      run(`${ffmpegBin()} -i "${rawPath}" -t 60 -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p -an -y "${normPath}"`)
      fs.renameSync(normPath, rawPath)
    }

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

    // 4. Scale footage to 1080p with ffmpeg (reduces Chrome memory; handles VFR → 30fps)
    // Remotion takes the scaled video as background — scale here so Chrome doesn't have to
    const scaledPath = path.join(tmpDir, 'scaled.mp4')
    const seekFlag = trimStart > 0 ? `-ss ${trimStart.toFixed(3)}` : ''
    run(
      `${ffmpegBin()} ${seekFlag} -i "${rawPath}" -vf "scale=1080:-2:flags=lanczos" ` +
      `-t ${duration.toFixed(3)} -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p -r 30 -an -y "${scaledPath}"`
    )

    // 5. Render text overlay + audio via Remotion (React-based — word stagger, emoji, per-brand font)
    const captionLines = overlayText
      .split('\n')
      .map((s: string) => s.trim())
      .filter(Boolean)
      .map((text: string, i: number, arr: string[]) => ({
        text,
        startSec: arr.length > 1 ? (duration / arr.length) * i : 0,
      }))

    console.log(`  Rendering with Remotion: ${captionLines.length} caption line(s), font="${brandConfig?.font_primary ?? 'default'}"`)
    await renderWithRemotion({
      videoPath: scaledPath,
      audioPath: hasAudio ? audioPath : undefined,
      captionLines,
      brandConfig: brandConfig as import('./remotion/types').VideoBrandConfig | null,
      durationSec: duration,
      outputPath: finalPath,
    })

    // 7. Thumbnail — first frame, no seek (avoids ENOENT on clips shorter than 1s)
    run(`${ffmpegBin()} -i "${finalPath}" -vframes 1 -y "${thumbPath}"`)

    // 8. Upload to R2
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
    const err = e as Error & { stderr?: Buffer }
    // ffmpeg stderr starts with hundreds of chars of version/config header before the real error.
    // Take the last 1000 chars of stderr (where the actual error line lives), fallback to message.
    const rawStderr = err.stderr?.toString().trim() ?? ''
    const msg = rawStderr
      ? rawStderr.slice(-1000)
      : err.message.slice(-1000)
    console.error(`[job] ✗ Failed ${jobId}:`, msg)
    await supabaseAdmin.from('video_jobs').update({
      status: 'error',
      error_message: msg,
    }).eq('id', jobId)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
