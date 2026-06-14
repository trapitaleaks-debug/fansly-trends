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

// ─── Twemoji emoji sticker helpers ────────────────────────────────────────────

function extractEmoji(text: string): string[] {
  // Match emoji sequences: base glyph + optional ZWJ/variation-selector chains
  const re = /\p{Extended_Pictographic}(?:️?(?:‍\p{Extended_Pictographic}️?)*)?️?/gu
  const seen = new Set<string>()
  for (const m of text.matchAll(re)) {
    if (m[0].trim()) seen.add(m[0])
  }
  return [...seen]
}

function emojiToTwemojiCP(emoji: string): string {
  // Twemoji filenames: hex codepoints joined by '-', FE0F stripped for simple emoji
  const cps = [...emoji].map(c => c.codePointAt(0)!)
  const hasZWJ = cps.includes(0x200D)
  // Keep FE0F in ZWJ sequences, strip for simple emoji
  const filtered = hasZWJ ? cps : cps.filter(cp => cp !== 0xFE0F)
  return filtered.map(cp => cp.toString(16)).join('-')
}

function downloadTwemojiPng(emoji: string, dest: string): boolean {
  const cp = emojiToTwemojiCP(emoji)
  const url = `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${cp}.png`
  try {
    execSync(`curl -sL --max-time 6 --fail "${url}" -o "${dest}"`, { stdio: 'pipe', env: process.env })
    return fs.existsSync(dest) && fs.statSync(dest).size > 200
  } catch {
    // Emoji may be newer than Twemoji v14.0.2 (Unicode 14) — skip silently
    return false
  }
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

    // 4. Render overlay — white Arial text + black border + Twemoji emoji stickers
    const encodeFlags = `-c:v libx264 -preset ultrafast -threads 2 -crf 23`
    console.log(`  Rendering overlay: "${overlayText}"`)

    // Text drawtext filter (strips emoji internally, uses system Liberation/Helvetica)
    const dtFilter = overlayText.trim() ? buildDrawtextFilter(overlayText, tmpDir) : null

    // Download Twemoji PNGs for each unique emoji in the text
    const emojis = extractEmoji(overlayText)
    const emojiPngs: string[] = []
    for (let i = 0; i < emojis.length; i++) {
      const dest = path.join(tmpDir, `emoji_${i}.png`)
      if (downloadTwemojiPng(emojis[i], dest)) {
        emojiPngs.push(dest)
        console.log(`  Emoji sticker: ${emojis[i]}`)
      }
    }

    if (emojiPngs.length === 0) {
      // No emoji or all failed to download — simple drawtext
      const vf = dtFilter ? `-vf "${dtFilter}"` : ''
      const videoIn = hasAudio ? `${ffmpegBin()} -i "${rawPath}" -i "${audioPath}"` : `${ffmpegBin()} -i "${rawPath}"`
      const audioMap = hasAudio ? `-c:a aac -shortest` : `-an`
      run(`${videoIn} ${vf} ${encodeFlags} ${audioMap} -y "${finalPath}"`)
    } else {
      // Build filter_complex: drawtext on video → overlay each emoji PNG centered below text
      const EMOJI_SIZE = 100
      const EMOJI_GAP = 8
      const totalEmojiW = emojiPngs.length * EMOJI_SIZE + (emojiPngs.length - 1) * EMOJI_GAP

      const fcParts: string[] = []
      let curLabel = '0:v'

      if (dtFilter) {
        fcParts.push(`[0:v]${dtFilter}[vt]`)
        curLabel = 'vt'
      }

      // Scale each emoji input (inputs 1..N are emoji PNGs)
      emojiPngs.forEach((_, i) => fcParts.push(`[${i + 1}:v]scale=${EMOJI_SIZE}:${EMOJI_SIZE}[e${i}]`))

      // Chain overlays: emoji row centered horizontally, just below text block
      emojiPngs.forEach((_, i) => {
        const xPos = `(W-${totalEmojiW})/2+${i * (EMOJI_SIZE + EMOJI_GAP)}`
        const outLabel = i === emojiPngs.length - 1 ? 'vout' : `vm${i}`
        fcParts.push(`[${curLabel}][e${i}]overlay=x=${xPos}:y=H*0.83[${outLabel}]`)
        curLabel = outLabel
      })

      const fc = fcParts.join(';')
      const emojiInputs = emojiPngs.map(p => `-i "${p}"`).join(' ')
      const audioInputIdx = 1 + emojiPngs.length
      const allInputs = hasAudio
        ? `${ffmpegBin()} -i "${rawPath}" ${emojiInputs} -i "${audioPath}"`
        : `${ffmpegBin()} -i "${rawPath}" ${emojiInputs}`
      const audioMap = hasAudio
        ? `-map "[vout]" -map ${audioInputIdx}:a -c:a aac -shortest`
        : `-map "[vout]" -an`

      run(`${allInputs} -filter_complex "${fc}" ${audioMap} ${encodeFlags} -y "${finalPath}"`)
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
