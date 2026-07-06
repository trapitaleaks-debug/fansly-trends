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

// ffmpeg/ffprobe are synchronous (execSync), so a hung process blocks the whole Node event
// loop — stalling the render worker with no recovery. Cap every invocation so a wedged ffmpeg
// is SIGKILLed and surfaces as a normal job error instead.
const FFMPEG_TIMEOUT_MS = 4 * 60 * 1000
const FFPROBE_TIMEOUT_MS = 30 * 1000

function run(cmd: string) {
  try {
    execSync(cmd, {
      stdio: 'pipe',
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
      timeout: FFMPEG_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
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
      id, post_id, model_id, clip_id, personalized_text, status, duration_seconds, template_id,
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

  // Atomic claim: flip pending → processing only if it's still pending. The render worker pool can
  // hand the same oldest-pending row to two workers before the status update lands; the conditional
  // .eq('status','pending') means only one wins (the other gets 0 rows and bails) — no double render.
  // started_at lets the watchdog reclaim a render that hangs past the wall-clock cap.
  const { data: claimed } = await supabaseAdmin.from('video_jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'pending')
    .select('id')
  if (!claimed || claimed.length === 0) {
    console.log(`[job] ${jobId} already claimed by another worker, skipping`)
    return
  }

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

    // Normalize clips that need it: .mov files, HEVC-encoded MP4s, and HDR/BT.2020 sources.
    // These all have container/codec/colorspace metadata that causes libx264 to fail with
    // "incorrect parameters" on Railway. -t 60 caps work to first 60s (we never use more than 15s).
    // CRITICAL: downscale to 1080p + 30fps DURING this transcode. iPhone footage is often 4K/60fps
    // HEVC (3840x2160, ~89Mbps); transcoding that at full res is ~8x the work and was timing out /
    // hanging the renderer. The output is downscaled to 1080p anyway, so do it here in one pass.
    let needsNormalize = clipKey.toLowerCase().endsWith('.mov')
    if (!needsNormalize) {
      try {
        const probe = execSync(
          `ffprobe -v quiet -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate,color_primaries -of csv=p=0 "${rawPath}"`,
          { env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` }, timeout: FFPROBE_TIMEOUT_MS, killSignal: 'SIGKILL' }
        ).toString().trim()
        const [codec = '', wStr = '', hStr = '', rfr = '', color = ''] = probe.split(',')
        const w = parseInt(wStr, 10) || 0
        const h = parseInt(hStr, 10) || 0
        const [rn, rd] = rfr.split('/').map(Number)
        const fps = rd ? rn / rd : (rn || 0)
        // Normalize (which now also downscales to 1080p/30) for anything heavy: HEVC, HDR/BT.2020,
        // larger-than-1080p (4K), or high frame rate — these are what hang/timeout the renderer.
        needsNormalize = codec.includes('hevc') || color.includes('bt2020') || w > 1920 || h > 1920 || fps > 31
      } catch { /* ignore probe errors — will attempt encode as-is */ }
    }
    if (needsNormalize) {
      const normPath = path.join(tmpDir, 'normalized.mp4')
      run(`${ffmpegBin()} -i "${rawPath}" -t 60 -vf "scale=1080:-2:flags=lanczos" -r 30 -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p -an -y "${normPath}"`)
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
        { env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` }, timeout: FFPROBE_TIMEOUT_MS, killSignal: 'SIGKILL' }
      ).toString().trim()
      fullDuration = parseFloat(fmtDur) || 0
    } catch { /* ignore */ }
    if (!fullDuration || fullDuration < 0.1) {
      try {
        const strmDur = execSync(
          `ffprobe -v quiet -select_streams v:0 -show_entries stream=duration -of csv=p=0 "${rawPath}"`,
          { env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` }, timeout: FFPROBE_TIMEOUT_MS, killSignal: 'SIGKILL' }
        ).toString().trim()
        fullDuration = parseFloat(strmDur) || 15
      } catch { fullDuration = 15 }
    }
    const clipDuration = trimEnd != null ? trimEnd - trimStart : fullDuration - trimStart

    // Wave B template (template_id NULL → classic caption path, byte-identical to pre-template).
    // A missing/non-live template row degrades to classic instead of failing the render.
    type TemplateRow = { manifest: import('./remotion/types').TemplateManifest | null; status: string }
    let templateRow: TemplateRow | null = null
    const templateId = (job as unknown as { template_id: string | null }).template_id
    if (templateId) {
      const { data: t } = await supabaseAdmin
        .from('video_templates')
        .select('manifest, status')
        .eq('id', templateId)
        .maybeSingle()
      if (t && (t as TemplateRow).status === 'live' && (t as TemplateRow).manifest) {
        templateRow = t as TemplateRow
      } else {
        console.log(`  Template ${templateId} missing/not-live — rendering classic caption layout`)
      }
    }
    const manifest = templateRow?.manifest ?? null

    // Template duration wins (the clip loops in-layout when shorter); classic path keeps
    // "never exceed actual clip length".
    const duration = manifest?.duration_sec
      ? Math.min(manifest.duration_sec, 10)
      : Math.min(requestedDuration, clipDuration)

    // Download template assets into tmpDir (served by the render file server) with
    // collision-safe names (raw.mp4/scaled.mp4/audio.aac live in the same dir).
    const templateAssetPaths: Record<string, string> = {}
    let stickerPath: string | undefined
    if (manifest) {
      const assetKeys = [
        manifest.slot?.frame_asset,
        manifest.slot?.fg_asset,
        ...(manifest.overlays ?? []).map(o => o.src),
      ].filter(Boolean) as string[]
      let n = 0
      for (const key of assetKeys) {
        const local = path.join(tmpDir, `tpl_${n++}${path.extname(key) || '.png'}`)
        await downloadFromR2(key, local)
        templateAssetPaths[key] = local
      }
      // Sticker slot → deterministic caption-mood pick from the shared pack (no LLM).
      if ((manifest.overlays ?? []).some(o => o.type === 'sticker') && process.env.STICKERS_LIVE === '1') {
        try {
          const { pickStickerKey } = await import('../lib/sticker-map')
          const stickerKey = await pickStickerKey(overlayText, jobId)
          if (stickerKey) {
            stickerPath = path.join(tmpDir, `tpl_sticker${path.extname(stickerKey) || '.png'}`)
            await downloadFromR2(stickerKey, stickerPath)
          }
        } catch (e) {
          console.log(`  Sticker pick failed (rendering without): ${(e as Error).message.slice(0, 80)}`)
          stickerPath = undefined
        }
      }
    }

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
    // Caption timing: lines may carry "|N%" suffix (e.g. "Cum hard|40%") declaring their share of
    // total video duration. Lines without a suffix share the remaining percentage equally.
    const rawLines = overlayText.split('\n').map((s: string) => s.trim()).filter(Boolean)
    const parsed = rawLines.map((line: string) => {
      const m = line.match(/^(.*?)\|(\d+(?:\.\d+)?)%\s*$/)
      return m ? { text: m[1].trim(), pct: parseFloat(m[2]) } : { text: line, pct: null as null | number }
    })
    type ParsedLine = { text: string; pct: number | null }
    const totalSpecified = parsed.reduce((sum: number, l: ParsedLine) => sum + (l.pct ?? 0), 0)
    const nullCount = parsed.filter((l: ParsedLine) => l.pct === null).length
    const defaultPct = nullCount > 0 ? Math.max(0, 100 - totalSpecified) / nullCount : 0
    let accumulated = 0
    const captionLines = parsed.map((l: ParsedLine) => {
      const startSec = (accumulated / 100) * duration
      accumulated += l.pct ?? defaultPct
      return { text: l.text, startSec }
    })

    // Apple emoji artwork for any emojis in the captions (user requirement: iOS look, and the
    // Linux render host has no Apple emoji font).
    let emojiImages: Record<string, string> | undefined
    try {
      const { appleEmojiDataUris } = await import('../lib/apple-emoji')
      const map = appleEmojiDataUris(overlayText)
      if (Object.keys(map).length > 0) emojiImages = map
    } catch (e) {
      console.log(`  Apple emoji map failed (font fallback): ${(e as Error).message.slice(0, 80)}`)
    }

    console.log(`  Rendering with Remotion: ${captionLines.length} caption line(s), font="${brandConfig?.font_primary ?? 'default'}"${manifest ? `, template layout=${manifest.layout}` : ''}${emojiImages ? `, ${Object.keys(emojiImages).length} apple emoji(s)` : ''}`)
    await renderWithRemotion({
      videoPath: scaledPath,
      audioPath: hasAudio ? audioPath : undefined,
      captionLines,
      brandConfig: brandConfig as import('./remotion/types').VideoBrandConfig | null,
      durationSec: duration,
      clipDurationSec: Math.min(clipDuration, duration),
      outputPath: finalPath,
      template: manifest ? { manifest, assetPaths: templateAssetPaths, stickerPath } : undefined,
      emojiImages,
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
    // Bounded render retry: re-queue to 'pending' (the render cron re-picks it) up to 3 attempts,
    // then mark terminal 'error'. Clear started_at either way so the watchdog ignores it.
    const { data: cur } = await supabaseAdmin.from('video_jobs').select('render_attempts').eq('id', jobId).single()
    const attempts = ((cur as unknown as { render_attempts: number } | null)?.render_attempts ?? 0) + 1
    const giveUp = attempts >= 3
    console.error(`[job] ✗ Failed ${jobId} [attempt ${attempts}/3]${giveUp ? ' — giving up (error)' : ' — re-queueing'}:`, msg)
    await supabaseAdmin.from('video_jobs').update({
      status: giveUp ? 'error' : 'pending',
      render_attempts: attempts,
      started_at: null,
      error_message: msg,
    }).eq('id', jobId)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
