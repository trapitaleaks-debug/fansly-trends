/**
 * One-time bootstrap: process a model's raw photo/video folder into a character sheet.
 *
 * Usage:
 *   npm run pipeline:bootstrap -- --handle liisaofficial --folder /path/to/raw
 *
 * What it does:
 *  1. Scans folder for images + videos
 *  2. Extracts frames from videos via ffmpeg
 *  3. Converts HEIC → JPEG via sips (macOS)
 *  4. Pre-filters by file size (≥ 100 KB) and resolution (≥ 720px tall)
 *  5. Scores top 60 candidates via Claude Vision (Haiku)
 *  6. Selects best 10-15 (3-4 face, 2-3 half-body, 2+ full-body)
 *  7. Uploads selected photos to R2 at models/{handle}/source/
 *  8. Uploads same photos to kie.ai temp host (expire in 3 days)
 *  9. Generates reference image using seedream/4.5-edit (4 variants)
 * 10. Scores variants, uploads winner to R2 at models/{handle}/reference/master.jpg
 * 11. Upserts pipeline_models row in Supabase
 */

import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import Anthropic from '@anthropic-ai/sdk'
import { uploadToR2 } from '../../lib/r2'
import { supabaseAdmin } from '../../lib/supabase'
import { uploadFileToKie, createImageTask, pollTask, sleep } from '../kie'

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetchBuffer ${url}: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

// ─── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  const get = (flag: string) => {
    const i = args.indexOf(flag)
    return i !== -1 ? args[i + 1] : undefined
  }
  const handle = get('--handle')
  const folder = get('--folder')
  if (!handle || !folder) {
    console.error('Usage: npm run pipeline:bootstrap -- --handle <handle> --folder <path>')
    process.exit(1)
  }
  return { handle, folder: path.resolve(folder) }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Candidate {
  path: string
  filename: string
  size: number
  width: number
  height: number
  isVideoFrame: boolean
}

interface Scored extends Candidate {
  score: number
  category: 'face_closeup' | 'half_body' | 'full_body' | 'other'
  reason: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd: string, opts: { cwd?: string; silent?: boolean } = {}) {
  try {
    return execSync(cmd, {
      cwd: opts.cwd,
      stdio: opts.silent ? 'pipe' : 'inherit',
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
    }).toString().trim()
  } catch {
    return ''
  }
}

function getImageDimensions(p: string): { width: number; height: number } | null {
  const out = run(
    `ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${p}"`,
    { silent: true }
  )
  if (!out) return null
  const [w, h] = out.split(',').map(Number)
  if (!w || !h) return null
  return { width: w, height: h }
}

function heicToJpeg(heicPath: string, outDir: string): string | null {
  const name = path.basename(heicPath, path.extname(heicPath)) + '.jpg'
  const outPath = path.join(outDir, name)
  run(`sips -s format jpeg "${heicPath}" --out "${outPath}"`, { silent: true })
  return fs.existsSync(outPath) ? outPath : null
}

async function extractFrames(videoPath: string, outDir: string, handle: string): Promise<Candidate[]> {
  const base = path.basename(videoPath, path.extname(videoPath)).replace(/[^a-z0-9]/gi, '_')
  const pattern = path.join(outDir, `${base}_frame_%03d.jpg`)
  run(
    `ffmpeg -i "${videoPath}" -vf "fps=1/5,scale='if(gt(iw,ih),-1,720)':'if(gt(iw,ih),720,-1)'" -q:v 2 "${pattern}" -y`,
    { silent: true }
  )
  const frames = fs.readdirSync(outDir)
    .filter(f => f.startsWith(`${base}_frame_`) && f.endsWith('.jpg'))
    .map(f => path.join(outDir, f))
  return frames.flatMap(fp => {
    const stat = fs.statSync(fp)
    const dims = getImageDimensions(fp)
    if (!dims) return []
    return [{ path: fp, filename: path.basename(fp), size: stat.size, ...dims, isVideoFrame: true }]
  })
}

// ─── Claude Vision scoring ────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

async function scoreImage(imagePath: string): Promise<{ score: number; category: Scored['category']; reason: string }> {
  const buffer = fs.readFileSync(imagePath)
  // Limit to 2 MB for API (resize if needed via ffmpeg)
  let imageData: string
  const MAX_BYTES = 1.8 * 1024 * 1024
  if (buffer.length > MAX_BYTES) {
    const tmpPath = imagePath + '_small.jpg'
    run(`ffmpeg -i "${imagePath}" -vf "scale=1080:-1" -q:v 4 "${tmpPath}" -y`, { silent: true })
    imageData = fs.existsSync(tmpPath) ? fs.readFileSync(tmpPath).toString('base64') : buffer.toString('base64')
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
  } else {
    imageData = buffer.toString('base64')
  }

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: imageData },
        },
        {
          type: 'text',
          text: `Score this photo for AI character sheet training (0-10).
Criteria: face clearly visible and sharp (+3), good even lighting no harsh shadows or blur (+2), no heavy filters or overlays (+2), correct resolution sharp focus (+2), natural expression (+1).
Also classify as: face_closeup (head/shoulders), half_body (waist up), full_body, or other.
Return ONLY valid JSON: {"score":7,"category":"face_closeup","reason":"brief one-line reason"}`,
        },
      ],
    }],
  })

  const text = (response.content[0] as { type: string; text: string }).text.trim()
  try {
    const parsed = JSON.parse(text)
    return { score: Number(parsed.score) || 0, category: parsed.category || 'other', reason: parsed.reason || '' }
  } catch {
    const scoreMatch = text.match(/"score"\s*:\s*(\d+)/)
    const catMatch = text.match(/"category"\s*:\s*"([^"]+)"/)
    return {
      score: scoreMatch ? Number(scoreMatch[1]) : 3,
      category: (catMatch?.[1] as Scored['category']) || 'other',
      reason: 'parse error',
    }
  }
}

async function scoreBatch(candidates: Candidate[]): Promise<Scored[]> {
  const results: Scored[] = []
  const BATCH = 5
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH)
    const scored = await Promise.all(
      batch.map(async c => {
        try {
          const s = await scoreImage(c.path)
          return { ...c, ...s } as Scored
        } catch (e) {
          console.error(`  ✗ Score failed for ${c.filename}:`, (e as Error).message)
          return { ...c, score: 0, category: 'other' as const, reason: 'error' }
        }
      })
    )
    results.push(...scored)
    process.stdout.write(`  Scored ${Math.min(i + BATCH, candidates.length)}/${candidates.length}\r`)
    if (i + BATCH < candidates.length) await sleep(3000)
  }
  console.log()
  return results
}

// ─── Photo selection ──────────────────────────────────────────────────────────

function selectPhotos(scored: Scored[]): Scored[] {
  const sorted = [...scored].sort((a, b) => b.score - a.score)
  const faces = sorted.filter(p => p.category === 'face_closeup' && p.score >= 5).slice(0, 4)
  const halves = sorted.filter(p => p.category === 'half_body' && p.score >= 5).slice(0, 3)
  const fulls = sorted.filter(p => p.category === 'full_body' && p.score >= 4).slice(0, 2)
  // Pad up to 15 from anything with score >= 4
  const selected = [...faces, ...halves, ...fulls]
  const usedPaths = new Set(selected.map(p => p.path))
  const extras = sorted.filter(p => !usedPaths.has(p.path) && p.score >= 4)
  const needed = Math.max(0, 12 - selected.length)
  return [...selected, ...extras.slice(0, needed)]
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { handle, folder } = parseArgs()
  console.log(`\n🚀 Bootstrap: @${handle}`)
  console.log(`   Folder: ${folder}\n`)

  if (!fs.existsSync(folder)) {
    console.error(`Folder not found: ${folder}`)
    process.exit(1)
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pipeline_${handle}_`))
  console.log(`   Tmp dir: ${tmpDir}`)

  // ── 1. Scan folder ────────────────────────────────────────────────────────
  console.log('\n[1/10] Scanning folder...')
  const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
  const HEIC_EXTS = new Set(['.heic', '.heif'])
  const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv'])

  const allFiles = fs.readdirSync(folder).filter(f => !f.startsWith('.'))
  let candidates: Candidate[] = []

  for (const f of allFiles) {
    const ext = path.extname(f).toLowerCase()
    const fullPath = path.join(folder, f)
    const stat = fs.statSync(fullPath)
    if (stat.size < 50 * 1024) continue // skip tiny files

    if (IMAGE_EXTS.has(ext)) {
      const dims = getImageDimensions(fullPath)
      if (dims) candidates.push({ path: fullPath, filename: f, size: stat.size, ...dims, isVideoFrame: false })
    } else if (HEIC_EXTS.has(ext)) {
      // Convert HEIC → JPEG first, then check dims
      const converted = heicToJpeg(fullPath, tmpDir)
      if (converted) {
        const dims = getImageDimensions(converted)
        if (dims) candidates.push({ path: converted, filename: path.basename(converted), size: stat.size, ...dims, isVideoFrame: false })
      }
    } else if (VIDEO_EXTS.has(ext)) {
      console.log(`  Extracting frames from ${f}...`)
      const frames = await extractFrames(fullPath, tmpDir, handle)
      console.log(`    → ${frames.length} frames`)
      candidates.push(...frames)
    }
  }

  console.log(`  Found ${candidates.length} candidates (images + frames)`)

  // ── 2. Pre-filter by resolution ───────────────────────────────────────────
  console.log('\n[2/10] Filtering by resolution (≥720px)...')
  candidates = candidates.filter(c => c.height >= 720 && c.size >= 100 * 1024)
  console.log(`  ${candidates.length} candidates after filter`)

  if (candidates.length < 5) {
    console.error('  ✗ Not enough quality photos. Add more material.')
    process.exit(1)
  }

  // ── 3. Sort by file size desc (proxy for quality), take top 60 ────────────
  console.log('\n[3/10] Pre-selecting top 60 by file size...')
  candidates.sort((a, b) => b.size - a.size)
  const topCandidates = candidates.slice(0, 60)
  console.log(`  Sending ${topCandidates.length} to Claude Vision scoring`)

  // ── 4. Score with Claude Vision ───────────────────────────────────────────
  console.log('\n[4/10] Scoring with Claude Vision (Haiku)...')
  const scored = await scoreBatch(topCandidates)

  // ── 5. Select best photos ─────────────────────────────────────────────────
  console.log('\n[5/10] Selecting best photos...')
  const selected = selectPhotos(scored)
  console.log(`  Selected ${selected.length} photos:`)
  selected.forEach(p => console.log(`    [${p.score}] ${p.category} — ${p.filename} (${p.reason})`))

  if (selected.length < 3) {
    console.error('  ✗ Not enough good photos selected. Try with more/better source material.')
    process.exit(1)
  }

  // ── 6. Upload selected to R2 ──────────────────────────────────────────────
  console.log('\n[6/10] Uploading to R2...')
  const r2Prefix = `models/${handle}/source`
  for (const photo of selected) {
    const key = `${r2Prefix}/${photo.filename}`
    const buf = fs.readFileSync(photo.path)
    await uploadToR2(key, buf, 'image/jpeg')
    console.log(`  ✓ R2: ${key}`)
  }

  // ── 7. Upload to kie.ai temp host ─────────────────────────────────────────
  console.log('\n[7/10] Uploading to kie.ai temp host...')
  const kieRefUrls: string[] = []
  for (let i = 0; i < selected.length; i++) {
    const photo = selected[i]
    try {
      const url = await uploadFileToKie(photo.path, photo.filename, `pipeline/${handle}`)
      kieRefUrls.push(url)
      console.log(`  ✓ kie.ai [${i + 1}/${selected.length}]: ${url.slice(0, 60)}...`)
      await sleep(600) // stay under rate limit
    } catch (e) {
      console.error(`  ✗ kie.ai upload failed for ${photo.filename}:`, (e as Error).message)
    }
  }
  console.log(`  ${kieRefUrls.length} photos uploaded to kie.ai`)

  if (kieRefUrls.length < 3) {
    console.error('  ✗ Not enough kie.ai uploads succeeded.')
    process.exit(1)
  }

  // ── 8. Generate 4 reference image variants ────────────────────────────────
  console.log('\n[8/10] Generating reference image (seedream/4.5-edit, 4 variants)...')
  const refPrompt = 'Ultra-realistic photograph. This exact person, same face, same body. Natural lighting, sharp focus. Professional portrait. 9:16 vertical. No watermarks.'
  const variantTaskIds: string[] = []

  for (let v = 0; v < 4; v++) {
    try {
      const taskId = await createImageTask(refPrompt, kieRefUrls)
      variantTaskIds.push(taskId)
      console.log(`  Variant ${v + 1}/4 queued: ${taskId}`)
      await sleep(700)
    } catch (e) {
      console.error(`  ✗ Variant ${v + 1} createTask failed:`, (e as Error).message)
    }
  }

  if (variantTaskIds.length === 0) {
    console.error('  ✗ All reference image tasks failed.')
    process.exit(1)
  }

  // Poll all variants
  const variantUrls: string[] = []
  for (const taskId of variantTaskIds) {
    console.log(`  Polling task ${taskId}...`)
    try {
      const url = await pollTask(taskId, 8 * 60 * 1000)
      variantUrls.push(url)
      console.log(`  ✓ ${url.slice(0, 60)}...`)
    } catch (e) {
      console.error(`  ✗ Task ${taskId} failed:`, (e as Error).message)
    }
  }

  if (variantUrls.length === 0) {
    console.error('  ✗ No reference variants generated.')
    process.exit(1)
  }

  // ── 9. Score variants, pick best ──────────────────────────────────────────
  console.log('\n[9/10] Scoring generated variants...')
  let bestUrl = variantUrls[0]
  let bestScore = 0

  for (const url of variantUrls) {
    const tmpFile = path.join(tmpDir, `variant_${variantUrls.indexOf(url)}.jpg`)
    const buf = await fetchBuffer(url)
    fs.writeFileSync(tmpFile, buf)
    const scored_variant = await scoreImage(tmpFile)
    console.log(`  Variant score: ${scored_variant.score} — ${scored_variant.reason}`)
    if (scored_variant.score > bestScore) {
      bestScore = scored_variant.score
      bestUrl = url
    }
    await sleep(1000)
  }

  console.log(`  Best variant score: ${bestScore}`)

  // ── 10. Upload master.jpg to R2 ────────────────────────────────────────────
  console.log('\n[10/10] Saving master reference to R2...')
  const masterBuf = await fetchBuffer(bestUrl)
  const masterKey = `models/${handle}/reference/master.jpg`
  await uploadToR2(masterKey, masterBuf, 'image/jpeg')
  console.log(`  ✓ R2: ${masterKey}`)

  // ── Upsert pipeline_models row ────────────────────────────────────────────
  console.log('\n💾 Writing pipeline_models row...')
  const { error } = await supabaseAdmin
    .from('pipeline_models')
    .upsert({
      handle,
      nsfw_flag: true,
      source_photos_r2_prefix: r2Prefix,
      reference_image_r2_key: masterKey,
      kie_ref_urls: kieRefUrls,
      kie_ref_uploaded_at: new Date().toISOString(),
      active: false,
    }, { onConflict: 'handle' })

  if (error) {
    console.error('  ✗ Supabase upsert failed:', error.message)
    process.exit(1)
  }
  console.log('  ✓ pipeline_models row written')

  // ── Cleanup ───────────────────────────────────────────────────────────────
  fs.rmSync(tmpDir, { recursive: true, force: true })

  console.log(`\n✅ Bootstrap complete for @${handle}`)
  console.log(`   Source photos: ${r2Prefix}/`)
  console.log(`   Reference:     ${masterKey}`)
  console.log(`   kie.ai refs:   ${kieRefUrls.length} URLs`)
  console.log(`\n   Next step: activate in Supabase and configure niche_tags + signature_tag`)
  console.log(`   UPDATE pipeline_models SET active=true, niche_tags='{"italian","curvy","blonde"}', signature_tag='#liisaofficial' WHERE handle='${handle}';`)
}

main().catch(e => {
  console.error('\n✗ Bootstrap failed:', e)
  process.exit(1)
})
