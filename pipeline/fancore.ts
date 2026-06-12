/**
 * Phase 6 — FanCore Playwright Posting
 * Posts approved videos to FanCore Bulk Posting as scheduled drafts.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { chromium, type Browser, type Page } from 'playwright'
import Anthropic from '@anthropic-ai/sdk'
import { r2 } from '../lib/r2'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getRunVideos, updateVideo, updateRunStatus, getRun, getTopHashtagsForModel, type PipelineModel, type PipelineVideo } from './db'

const BUCKET = process.env.R2_BUCKET_NAME ?? 'fansly-trends'
const FANCORE_URL = 'https://fancore-production.up.railway.app'
const SESSION_FILE = path.join(__dirname, 'sessions', 'fancore.json')

async function downloadFromR2(key: string, destPath: string): Promise<void> {
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  const body = res.Body
  if (!body) throw new Error(`R2 key not found: ${key}`)
  const chunks: Uint8Array[] = []
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk)
  fs.writeFileSync(destPath, Buffer.concat(chunks))
}

async function loginFanCore(page: Page): Promise<void> {
  const email = process.env.FANCORE_EMAIL!
  const password = process.env.FANCORE_PASSWORD!

  if (!email || !password) throw new Error('FANCORE_EMAIL or FANCORE_PASSWORD not set')

  await page.goto(`${FANCORE_URL}/signin`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', password)
  await page.locator('button.btn-violet').click()
  await page.waitForURL(url => !String(url).includes('/signin'), { timeout: 20000 })
  console.log('  ✓ FanCore logged in')
}

async function saveSession(page: Page): Promise<void> {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true })
  const cookies = await page.context().cookies()
  fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2))
}

async function loadSession(page: Page): Promise<boolean> {
  if (!fs.existsSync(SESSION_FILE)) return false
  try {
    const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))
    await page.context().addCookies(cookies)
    await page.goto(FANCORE_URL, { waitUntil: 'domcontentloaded' })
    const isLoggedIn = !page.url().includes('/signin')
    return isLoggedIn
  } catch {
    return false
  }
}

function getScheduledTime(slot: number, bestTimes: { morning: string; evening: string }): Date {
  // Slot 1,2 = Day 0, Slot 3,4 = Day 1, Slot 5,6 = Day 2
  const dayOffset = Math.floor((slot - 1) / 2)
  const isEvening = slot % 2 === 0

  const timeStr = isEvening ? bestTimes.evening : bestTimes.morning
  const [hours, minutes] = timeStr.split(':').map(Number)

  const date = new Date()
  date.setUTCDate(date.getUTCDate() + dayOffset)
  date.setUTCHours(hours, minutes || 0, 0, 0)

  // If the time is in the past, push to next occurrence
  if (date < new Date()) {
    date.setUTCDate(date.getUTCDate() + 1)
  }

  return date
}

const BANNED_HASHTAGS = new Set([
  // explicit acts
  'anal','analsex','deepthroat','blowjob','bj','handjob','rimjob','rimming','fisting',
  'fuck','hardfuck','standingfuck','dp','doublepenetration','hardcore',
  // body fluids / finishing
  'cum','cumshot','creampie','facial','squirt','squirting',
  // body parts / size
  'bigdick','hugedick','bigcock','hugecock','monstercock','bbc','bwc',
  // scenarios / categories
  'porn','sex','sextape','hotwife','swingers','wifesharing','wifeswap','blacked','breeding',
  'gangbang','taboo','incest','stepsister','stepbrother','stepmom','stepdad',
  // nudity
  'nude','naked','xxx',
  // fetish / niche
  'bdsm','bondage','dominatrix','cuckold','feet','footfetish',
  'scat','piss','pissing','futa','futanari',
  'furry','hentai','femboy','ladyboy','shemale','trans',
])

async function selectHashtags(video: PipelineVideo, model: PipelineModel): Promise<string[]> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // 1. Fetch current trending tags from fansly-tags
  let trendingImpact: string[] = []
  let trendingRising: string[] = []
  try {
    const res = await fetch('https://fansly-tags.vercel.app/api/tags', {
      headers: { 'Cache-Control': 'no-store' },
    } as RequestInit)
    if (res.ok) {
      const data = await res.json() as {
        highestImpact?: { tag: string }[]
        fastestRising?: { tag: string }[]
      }
      trendingImpact = (data.highestImpact ?? [])
        .map(t => t.tag)
        .filter(t => !BANNED_HASHTAGS.has(t.toLowerCase()))
        .slice(0, 20)
      trendingRising = (data.fastestRising ?? [])
        .map(t => t.tag)
        .filter(t => !BANNED_HASHTAGS.has(t.toLowerCase()))
        .slice(0, 15)
    }
  } catch { /* skip — use fallback pools only */ }

  // 2. Get top-performing tags from past analytics for this model
  const pastTopTags = await getTopHashtagsForModel(model.id)

  const brief = video.brief!
  const brandingSnippet = model.branding_file_text
    ? model.branding_file_text.slice(0, 500)
    : `Niche: ${model.niche_tags.join(', ')}`

  const prompt = `Select exactly 10 hashtags for this Fansly video post. Return ONLY a JSON array of 10 strings, lowercase, no # symbol. Nothing else.

VIDEO:
- Format: ${brief.content_format}
- Overlay: "${brief.overlay_text}"
- Concept: "${brief.concept}"

MODEL BRANDING:
${brandingSnippet}
Niche tags: ${model.niche_tags.join(', ')}
Signature tag: ${model.signature_tag ?? 'none'}

CURRENTLY TRENDING — Highest Impact:
${trendingImpact.join(', ') || 'unavailable'}

CURRENTLY TRENDING — Fastest Rising:
${trendingRising.join(', ') || 'unavailable'}

TOP PERFORMERS FOR THIS MODEL (from FanCore analytics):
${pastTopTags.length > 0 ? pastTopTags.join(', ') : 'no data yet — skip this constraint'}

RULES:
- Always include the model's signature tag if set
- Pick 2–3 from Highest Impact that match the video's content/vibe
- Pick 1–2 from Fastest Rising if relevant
- Pick 1–2 from past top performers if contextually relevant
- Fill remaining slots with niche-specific tags that fit this specific video
- Do NOT use banned tags: anal, trans, deepthroat, creampie, gangbang, bdsm, etc.
- Tags must vary from a standard rotation — do not always return the same 10`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = (response.content[0] as { type: string; text: string }).text.trim()
    const match = text.match(/\[[\s\S]*?\]/)
    if (match) {
      const tags: string[] = JSON.parse(match[0])
      return tags.filter(t => !BANNED_HASHTAGS.has(t.toLowerCase())).slice(0, 10)
    }
  } catch (e) {
    console.error('  ⚠ selectHashtags failed:', (e as Error).message)
  }

  // Fallback: niche tags + signature
  const fallback = [...model.niche_tags]
  if (model.signature_tag) fallback.unshift(model.signature_tag)
  return fallback.slice(0, 10)
}

export async function postBatch(runId: string, model: PipelineModel): Promise<void> {
  console.log(`[fancore] Posting run ${runId} for @${model.handle}`)

  const run = await getRun(runId)
  if (!run) throw new Error(`Run ${runId} not found`)

  const videos = await getRunVideos(runId)
  const approved = videos.filter(v => v.status === 'pending' || v.status === 'approved')

  if (approved.length === 0) {
    console.log('  No approved videos to post')
    return
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `fancore_post_`))
  const browser: Browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  try {
    // Login or restore session
    const sessionRestored = await loadSession(page)
    if (!sessionRestored) {
      await loginFanCore(page)
      await saveSession(page)
    }

    await updateRunStatus(runId, 'posting')

    for (const video of approved) {
      if (!video.final_r2_key || !video.brief) {
        console.error(`  ✗ Slot ${video.slot} missing r2 key or brief, skipping`)
        continue
      }

      console.log(`\n  [Slot ${video.slot}] Uploading to FanCore...`)

      // Select optimal hashtags just before posting
      console.log(`  [Slot ${video.slot}] Selecting hashtags...`)
      const selectedHashtags = await selectHashtags(video, model)
      console.log(`  [Slot ${video.slot}] Tags: ${selectedHashtags.join(', ')}`)

      // Persist selected hashtags to brief in DB for analytics tracking
      await updateVideo(video.id, {
        brief: { ...video.brief!, hashtags: selectedHashtags },
      })

      // Download video to temp
      const videoPath = path.join(tmpDir, `slot_${video.slot}.mp4`)
      await downloadFromR2(video.final_r2_key, videoPath)

      // Select model in sidebar (same pattern as onboarding scripts)
      const handle = model.handle.replace('@', '')
      await page.goto(FANCORE_URL, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2000)
      for (const sel of [`text=@${handle}`, `text=${handle}`]) {
        const el = page.locator(sel).first()
        if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
          await el.click({ force: true })
          break
        }
      }
      await page.waitForTimeout(1500)

      // Navigate to Reels / Bulk Posts section
      await page.goto(`${FANCORE_URL}/reels`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2000)

      // Try "New Post" or "Upload" button
      const newPostBtn = page.locator('button').filter({ hasText: /New|Upload|Create|Add/i }).first()
      if (await newPostBtn.isVisible({ timeout: 3000 })) {
        await newPostBtn.click()
        await page.waitForTimeout(2000)
      }

      // Handle file upload
      const fileInput = page.locator('input[type="file"]').first()
      await fileInput.setInputFiles(videoPath)
      await page.waitForTimeout(3000) // Wait for upload processing

      // Fill caption with hashtags selected just before posting
      const caption = selectedHashtags.map(t => `#${t}`).join(' ')
      const captionField = page.locator('textarea').first()
      await captionField.fill(caption)

      // Set scheduled time
      const bestTimes = model.best_post_times ?? { morning: '10:00', evening: '18:00' }
      const scheduledFor = getScheduledTime(video.slot, bestTimes)
      video.scheduled_for = scheduledFor.toISOString()

      // Try to set scheduled date if the UI has a date/time picker
      try {
        const dateInput = page.locator('input[type="datetime-local"]').first()
        if (await dateInput.isVisible({ timeout: 2000 })) {
          const formatted = scheduledFor.toISOString().slice(0, 16) // YYYY-MM-DDTHH:mm
          await dateInput.fill(formatted)
        }
      } catch {
        // UI may not have scheduling, post as draft
      }

      // Save as draft
      const saveBtn = page.locator('button').filter({ hasText: /Save|Draft|Schedule/i }).first()
      if (await saveBtn.isVisible({ timeout: 3000 })) {
        await saveBtn.click()
        await page.waitForTimeout(2000)
      }

      await updateVideo(video.id, {
        status: 'posted',
        scheduled_for: scheduledFor.toISOString(),
      })

      console.log(`  ✓ Slot ${video.slot} posted (scheduled ${scheduledFor.toUTCString()})`)
    }

    await updateRunStatus(runId, 'posted')
    console.log(`\n[fancore] ✓ Run ${runId} fully posted`)

  } finally {
    await browser.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
