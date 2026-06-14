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
import { buildComposition, type BrandConfig } from './compose'

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
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
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

const FONTS_DIR = path.resolve(__dirname, '../pipeline/fonts')

function stripEmojiForDrawtext(text: string): string {
  return text
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
    .replace(/‍/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitBrandLines(text: string): Array<{ text: string; size: 'lg' | 'sm' | 'xs' }> {
  const byNewline = text.split(/\n/).map(p => p.trim()).filter(Boolean)
  if (byNewline.length >= 2) {
    if (byNewline.length === 2) return [{ text: byNewline[0], size: 'sm' }, { text: byNewline[1], size: 'lg' }]
    return byNewline.map((p, i) => ({ text: p, size: (i === 0 || i === byNewline.length - 1 ? 'sm' : 'lg') as 'lg' | 'sm' | 'xs' }))
  }
  const p = text.trim()
  const m = p.match(/^(.+?[.!?,…])\s+(.+)$/)
  if (m && m[1].length > 4 && m[2].length > 3) {
    return [{ text: m[1], size: 'sm' }, { text: m[2], size: 'lg' }]
  }
  return [{ text: p, size: 'lg' }]
}

function buildBrandDrawtextFilter(overlayText: string, config: BrandConfig, tmpDir: string): string {
  const text = stripEmojiForDrawtext(overlayText.trim())
  if (!text) return ''

  const fontTtf = path.join(FONTS_DIR, 'CormorantGaramond-BoldItalic.ttf')
  if (!fs.existsSync(fontTtf)) {
    console.log('  Brand TTF not found, falling back to default drawtext')
    return buildDrawtextFilter(overlayText, tmpDir)
  }

  const lines = splitBrandLines(text)
  const SIZE: Record<string, number> = { lg: 90, sm: 61, xs: 46 }
  const lineSpacing = 12

  const heights = lines.map(l => SIZE[l.size])
  const totalH = heights.reduce((a, b) => a + b, 0) + lineSpacing * (lines.length - 1)

  // ffmpeg color format: 0xRRGGBBAA
  const textColor = config.color_text.replace('#', '0x') + 'FF'
  const shadowColor = (config.color_shadow ?? '#0A0A0A').replace('#', '0x') + 'AA'

  const filters: string[] = []
  let yAccum = 0

  lines.forEach((line, i) => {
    const fontSize = SIZE[line.size]
    const yExpr = `(h-${totalH})/2+${yAccum}`

    // Write text to file to avoid all shell/ffmpeg escaping issues
    const textFile = path.join(tmpDir, `brand_l${i}.txt`)
    fs.writeFileSync(textFile, line.text, 'utf8')

    filters.push([
      `drawtext=fontfile='${fontTtf}'`,
      `textfile='${textFile}'`,
      `fontsize=${fontSize}`,
      `fontcolor=${textColor}`,
      `bordercolor=white@1.0`,
      `borderw=2`,
      `shadowcolor=${shadowColor}`,
      `shadowx=3`,
      `shadowy=3`,
      `x=(w-text_w)/2`,
      `y=${yExpr}`,
    ].join(':'))

    yAccum += fontSize + lineSpacing
  })

  return filters.join(',')
}

async function renderWithHyperframes(rawPath: string, composedPath: string, compositionHtml: string, tmpDir: string): Promise<void> {
  const normPath = path.join(tmpDir, 'hf_norm.mp4')
  run(`${ffmpegBin()} -i "${rawPath}" -c:v libx264 -preset ultrafast -threads 2 -crf 18 -an -y "${normPath}"`)

  const compDir = path.join(tmpDir, 'comp')
  fs.mkdirSync(compDir, { recursive: true })
  fs.symlinkSync(normPath, path.join(compDir, 'video.mp4'))

  // Copy bundled fonts so Chrome can load them from disk (no network needed)
  if (fs.existsSync(FONTS_DIR)) {
    for (const f of fs.readdirSync(FONTS_DIR)) {
      fs.copyFileSync(path.join(FONTS_DIR, f), path.join(compDir, f))
    }
  }

  fs.writeFileSync(path.join(compDir, 'index.html'), compositionHtml, 'utf8')

  const bin = hyperframesBin()
  run(`"${bin}" render "${compDir}" -o "${composedPath}" --no-browser-gpu --fps 30 --workers 1`)
}

export async function processVideoJob(jobId: string): Promise<void> {
  console.log(`[job] Processing video_job ${jobId}`)

  // Load job with related data
  const { data: job, error: jobErr } = await supabaseAdmin
    .from('video_jobs')
    .select(`
      id, post_id, model_id, clip_id, personalized_text, status,
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

    // 2. Get duration
    const durationRaw = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${rawPath}"`,
      { env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` } }
    ).toString().trim()
    const duration = parseFloat(durationRaw) || 10

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

    // 4. Render overlay text
    const encodeFlags = `-c:v libx264 -preset ultrafast -threads 2 -crf 23`
    console.log(`  Rendering overlay: "${overlayText}"`)

    const base = (extra?: string) =>
      hasAudio
        ? `${ffmpegBin()} -i "${rawPath}" -i "${audioPath}"${extra ? ' ' + extra : ''}`
        : `${ffmpegBin()} -i "${rawPath}"${extra ? ' ' + extra : ''}`
    const audioMap = hasAudio ? `-c:a aac -shortest` : `-an`

    if (brandConfig && overlayText.trim()) {
      // Brand config: ffmpeg drawtext with bundled TTF — no Hyperframes, no Chrome, works everywhere
      console.log(`  Brand drawtext: ${brandConfig.font_primary} ${brandConfig.color_text}`)
      const dtFilter = buildBrandDrawtextFilter(overlayText, brandConfig, tmpDir)
      const vf = dtFilter ? `-vf "${dtFilter}"` : ''
      run(`${base()} ${vf} ${encodeFlags} ${audioMap} -y "${finalPath}"`)
    } else if (process.platform !== 'darwin') {
      // Linux/Railway: Hyperframes for default Arial Black style
      const composedPath = path.join(tmpDir, 'composed.mp4')
      let hfOk = false
      try {
        const compositionHtml = buildComposition({ videoFile: 'video.mp4', overlayText, duration, slot: 1 })
        await renderWithHyperframes(rawPath, composedPath, compositionHtml, tmpDir)
        hfOk = true
      } catch (e) {
        console.log(`  Hyperframes failed — falling back to ffmpeg: ${(e as Error).message}`)
      }

      if (hfOk) {
        if (hasAudio) {
          run(`${ffmpegBin()} -i "${composedPath}" -i "${audioPath}" -c:v copy -c:a aac -shortest -y "${finalPath}"`)
        } else {
          fs.renameSync(composedPath, finalPath)
        }
      } else {
        const dtFilter = overlayText.trim() ? buildDrawtextFilter(overlayText, tmpDir) : null
        const vf = dtFilter ? `-vf "${dtFilter}"` : ''
        run(`${base()} ${vf} ${encodeFlags} ${audioMap} -y "${finalPath}"`)
      }
    } else {
      // Mac dev: default ffmpeg drawtext
      const dtFilter = overlayText.trim() ? buildDrawtextFilter(overlayText, tmpDir) : null
      const vf = dtFilter ? `-vf "${dtFilter}"` : ''
      run(`${base()} ${vf} ${encodeFlags} ${audioMap} -y "${finalPath}"`)
    }

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
