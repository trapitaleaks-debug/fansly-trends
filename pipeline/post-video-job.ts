/**
 * FanCore auto-posting for content bank video jobs.
 * Called after a video_job renders successfully (status → done).
 * Schedules the post at 22:00 UTC — max 2 per day per model.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import Anthropic from '@anthropic-ai/sdk'
import { r2, uploadToR2 } from '../lib/r2'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { supabaseAdmin } from '../lib/supabase'
import { sendTelegram } from '../lib/telegram'

const BUCKET = process.env.R2_BUCKET_NAME ?? 'fansly-trends'
const FANCORE_URL = 'https://fancore-production.up.railway.app'
const SESSION_R2_KEY = 'sessions/fancore.json'
const POST_HOUR_UTC = 22
const DAILY_LIMIT = 2

const BANNED_HASHTAGS = new Set([
  'anal','analsex','deepthroat','blowjob','bj','handjob','rimjob','rimming','fisting',
  'fuck','hardfuck','dp','doublepenetration','hardcore','cum','cumshot','creampie',
  'facial','squirt','squirting','bigdick','hugedick','bigcock','hugecock','monstercock',
  'bbc','bwc','porn','sex','sextape','hotwife','swingers','gangbang','taboo','incest',
  'stepsister','stepbrother','stepmom','stepdad','nude','naked','xxx','bdsm','bondage',
  'dominatrix','cuckold','feet','footfetish','scat','piss','pissing','futa','futanari',
  'furry','hentai','femboy','ladyboy','shemale','trans',
])

async function selectHashtags(overlayText: string, nicheHashtags: string[]): Promise<string[]> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  let trendingImpact: string[] = []
  let trendingRising: string[] = []
  try {
    const res = await fetch('https://fansly-tags.vercel.app/api/tags', {
      headers: { 'Cache-Control': 'no-store' },
    } as RequestInit)
    if (res.ok) {
      const data = await res.json() as { highestImpact?: { tag: string }[]; fastestRising?: { tag: string }[] }
      trendingImpact = (data.highestImpact ?? []).map(t => t.tag).filter(t => !BANNED_HASHTAGS.has(t.toLowerCase())).slice(0, 20)
      trendingRising = (data.fastestRising ?? []).map(t => t.tag).filter(t => !BANNED_HASHTAGS.has(t.toLowerCase())).slice(0, 15)
    }
  } catch { /* skip — use niche tags as fallback */ }

  const prompt = `Select exactly 10 hashtags for this Fansly video post. Return ONLY a JSON array of 10 strings, lowercase, no # symbol. Nothing else.

VIDEO OVERLAY TEXT: "${overlayText}"

MODEL NICHE TAGS: ${nicheHashtags.join(', ') || 'none'}

CURRENTLY TRENDING — Highest Impact:
${trendingImpact.join(', ') || 'unavailable'}

CURRENTLY TRENDING — Fastest Rising:
${trendingRising.join(', ') || 'unavailable'}

RULES:
- Pick 2–3 from Highest Impact that match the video's content/vibe
- Pick 1–2 from Fastest Rising if relevant
- Fill remaining slots with niche-specific tags that fit this video
- Always vary — do not return the same 10 every time
- Do NOT use banned tags: anal, trans, deepthroat, creampie, gangbang, bdsm, etc.`

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

  // Fallback: model's niche hashtags
  return nicheHashtags.slice(0, 10)
}

async function downloadFromR2(key: string, destPath: string): Promise<void> {
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  const body = res.Body
  if (!body) throw new Error(`R2 key not found: ${key}`)
  const chunks: Uint8Array[] = []
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk)
  fs.writeFileSync(destPath, Buffer.concat(chunks))
}

async function loginFanCore(page: Page): Promise<void> {
  const email = process.env.FANCORE_EMAIL
  const password = process.env.FANCORE_PASSWORD
  if (!email || !password) throw new Error('FANCORE_EMAIL or FANCORE_PASSWORD not set')
  await page.goto(`${FANCORE_URL}/signin`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', password)
  await page.locator('button.btn-violet').click()
  await page.waitForURL(url => !String(url).includes('/signin'), { timeout: 20_000 })
  console.log('  ✓ FanCore logged in')
}

// Store full storageState (cookies + localStorage) in R2.
// FanCore uses JWT in localStorage so addCookies() alone is not enough.
async function saveSession(page: Page): Promise<void> {
  try {
    const state = await page.context().storageState()
    await uploadToR2(SESSION_R2_KEY, Buffer.from(JSON.stringify(state)), 'application/json')
    console.log('  ✓ Session saved to R2')
  } catch (e) {
    console.error('  ⚠ saveSession failed:', (e as Error).message)
  }
}

async function loadStorageState(): Promise<object | null> {
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: SESSION_R2_KEY }))
    const chunks: Uint8Array[] = []
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk)
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    return null
  }
}

// Returns a new browser context — pre-loaded with saved storageState if available.
// Caller must check if session is valid and login if not.
async function createContext(browser: Browser): Promise<{ context: BrowserContext; hadSavedSession: boolean }> {
  const savedState = await loadStorageState()
  if (savedState) {
    console.log('  ✓ Loaded session from R2')
    const context = await browser.newContext({
      timezoneId: 'UTC',
      storageState: savedState as import('playwright').BrowserContextOptions['storageState'],
    })
    return { context, hadSavedSession: true }
  }
  console.log('  ℹ No saved session — will login fresh')
  return { context: await browser.newContext({ timezoneId: 'UTC' }), hadSavedSession: false }
}

// Returns the next 22:00 UTC datetime where this model has fewer than DAILY_LIMIT posts scheduled
async function getNextSlot(modelId: string): Promise<Date> {
  const { data } = await supabaseAdmin
    .from('video_jobs')
    .select('scheduled_for')
    .eq('model_id', modelId)
    .not('scheduled_for', 'is', null)
    .gte('scheduled_for', new Date().toISOString())

  // Count how many posts are scheduled per calendar day (UTC)
  const counts = new Map<string, number>()
  for (const row of (data ?? [])) {
    const d = new Date(row.scheduled_for)
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const now = new Date()
  // Start from today's 22:00 UTC; if that's already past, start from tomorrow's
  let candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), POST_HOUR_UTC, 0, 0, 0))
  if (candidate <= now) candidate = new Date(candidate.getTime() + 86_400_000)

  for (let i = 0; i < 30; i++) {
    const key = `${candidate.getUTCFullYear()}-${candidate.getUTCMonth()}-${candidate.getUTCDate()}`
    if ((counts.get(key) ?? 0) < DAILY_LIMIT) return candidate
    candidate = new Date(candidate.getTime() + 86_400_000)
  }

  return candidate
}

export async function postVideoJob(jobId: string): Promise<void> {
  // Load job + model
  const { data: job, error: jobErr } = await supabaseAdmin
    .from('video_jobs')
    .select('id, model_id, personalized_text, output_r2_key, trends_models(fansly_username, hashtags)')
    .eq('id', jobId)
    .single()

  if (jobErr || !job) throw new Error(`postVideoJob: job not found — ${jobErr?.message}`)
  if (!job.output_r2_key) throw new Error(`postVideoJob: no output_r2_key for job ${jobId}`)

  const modelMeta = (job as unknown as { trends_models: { fansly_username: string; hashtags: string[] } | null }).trends_models
  if (!modelMeta) throw new Error(`postVideoJob: no model data for job ${jobId}`)

  const handle = modelMeta.fansly_username
  const nicheHashtags: string[] = modelMeta.hashtags ?? []
  const overlayText = (job as unknown as { personalized_text: string | null }).personalized_text ?? ''

  const selectedHashtags = await selectHashtags(overlayText, nicheHashtags)
  console.log(`[post] Tags for ${jobId}: ${selectedHashtags.join(' ')}`)

  const scheduledFor = await getNextSlot(job.model_id)
  console.log(`[post] Scheduling job ${jobId} for @${handle} at ${scheduledFor.toUTCString()}`)

  await supabaseAdmin.from('video_jobs').update({ status: 'posting' }).eq('id', jobId)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc_post_'))
  const browser: Browser = await chromium.launch({ headless: true })
  // createContext loads saved storageState from R2 (cookies + localStorage)
  // UTC timezone so 22:00 entered in date picker = 22:00 UTC
  const { context } = await createContext(browser)
  const page = await context.newPage()

  try {
    // Navigate to /bulk-posts and verify auth — storageState may have expired tokens
    await page.goto(`${FANCORE_URL}/bulk-posts`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    if (page.url().includes('/signin')) {
      console.log('  ℹ Session expired — logging in fresh')
      await loginFanCore(page)
      await saveSession(page)
      await page.goto(`${FANCORE_URL}/bulk-posts`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    } else {
      console.log('  ✓ Session valid')
    }
    // Wait for sidebar models API call to complete after domcontentloaded
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})

    // Click the model entry in the left sidebar — wait up to 30s for it to render
    const modelEntry = page.getByText(`@${handle}`, { exact: true }).first()
    try {
      await modelEntry.waitFor({ state: 'visible', timeout: 30_000 })
    } catch {
      // Debug: save screenshot of what the page looks like when sidebar fails to load
      await page.screenshot({ type: 'png' }).then(buf =>
        uploadToR2(`debug/post-${jobId}-sidebar.png`, buf, 'image/png')
      ).catch(() => {})
      console.log(`[post] sidebar debug screenshot → debug/post-${jobId}-sidebar.png`)
      throw new Error(`Sidebar: @${handle} not visible after 30s — check debug/post-${jobId}-sidebar.png in R2`)
    }
    await modelEntry.click()
    await page.waitForTimeout(2000)

    // Download video from R2
    const videoPath = path.join(tmpDir, 'output.mp4')
    await downloadFromR2(job.output_r2_key, videoPath)

    // All fields below target the first form slot with .nth(0)

    // 1. Tags — space-separated with # prefix
    const tagsInput = page.locator('input[placeholder*="petite"], input[placeholder*="kawaii"], input[placeholder*="fyp"]').nth(0)
    await tagsInput.fill(selectedHashtags.map(t => `#${t}`).join(' '))

    // 2. Schedule for — field is read-only (mdm-cal custom datepicker).
    //    Save a pre-picker screenshot first to diagnose selector issues in Railway.
    await page.screenshot({ type: 'png', fullPage: true }).then(buf =>
      uploadToR2(`debug/post-${jobId}-before-datepicker.png`, buf, 'image/png')
    ).catch(() => {})

    const targetDay = scheduledFor.getUTCDate()

    // Try multiple strategies to open the calendar:
    //   1. Click the black calendar icon button (svg/img next to the input)
    //   2. Click any input-like element near "Schedule for" label
    //   3. Force-click any date-placeholder input
    const calendarOpened = await (async () => {
      // Strategy 1: click the calendar icon button (typically an SVG or img trigger)
      const calIconBtn = page.locator('button[class*="cal"], button[aria-label*="date"], button[aria-label*="calendar"], [class*="datepick"] button, [class*="schedule"] button, [class*="mdm-cal"] button').first()
      const calIconVisible = await calIconBtn.isVisible().catch(() => false)
      if (calIconVisible) {
        await calIconBtn.click({ force: true })
        await page.waitForTimeout(800)
        return true
      }
      // Strategy 2: find input by any date-related placeholder or near "Schedule for"
      const dateInputs = await page.locator('input[placeholder*="/"], input[placeholder*="date"], input[placeholder*="Date"], input[readonly][class*="date"], input[readonly][class*="mdm"]').all()
      if (dateInputs.length > 0) {
        await dateInputs[0].scrollIntoViewIfNeeded().catch(() => {})
        await dateInputs[0].click({ force: true }).catch(() => {})
        await page.waitForTimeout(800)
        return true
      }
      // Strategy 3: click any element whose text or placeholder contains the date format pattern
      // or click a wrapper div with mdm-cal in class
      const mdmTrigger = page.locator('[class*="mdm-cal-trigger"], [class*="mdm-cal-input"], [class*="date-picker"]').first()
      const mdmVisible = await mdmTrigger.isVisible().catch(() => false)
      if (mdmVisible) {
        await mdmTrigger.click({ force: true })
        await page.waitForTimeout(800)
        return true
      }
      return false
    })()
    console.log(`[post] calendar open strategy: ${calendarOpened}`)

    // Debug screenshot (fullPage so we can see the calendar even if it's below fold)
    await page.screenshot({ type: 'png', fullPage: true }).then(buf =>
      uploadToR2(`debug/post-${jobId}-datepicker.png`, buf, 'image/png')
    ).catch(() => {})

    // Dump calendar HTML to console to discover actual element classes
    const calHtml = await page.evaluate(() => {
      const el = document.querySelector('[class*="mdm-cal"], [class*="mdm_cal"], [class*="calendar"], [id*="cal"]')
      return el ? el.outerHTML.slice(0, 4000) : 'NO calendar element found'
    }).catch(() => 'evaluate failed')
    console.log(`[post] calendar DOM: ${calHtml}`)

    // Select the correct day (mdm-cal-day class; fallback to generic day selector)
    await page.locator(`[class*="mdm-cal-day"]:not([class*="prev"]):not([class*="next"]):not([class*="disabled"]), [class*="mdm-cal"] [class*="day"]:not([class*="disabled"])`)
      .filter({ hasText: new RegExp(`^${targetDay}$`) }).first()
      .click({ force: true }).catch(e => console.log(`[post] day click: ${e.message}`))
    await page.waitForTimeout(400)

    // Set hour = 22 in the mdm-cal time column
    await page.locator(`[class*="mdm-cal"] *`).filter({ hasText: /^22$/ }).first()
      .click({ force: true }).catch(e => console.log(`[post] hour click: ${e.message}`))
    await page.waitForTimeout(300)

    // Set minute = 00 in the mdm-cal time column
    await page.locator(`[class*="mdm-cal"] *`).filter({ hasText: /^00$/ }).first()
      .click({ force: true }).catch(e => console.log(`[post] minute click: ${e.message}`))
    await page.waitForTimeout(300)

    // Click the mdm-cal Done button to confirm the selection (id=mdmCalDone)
    await page.locator('#mdmCalDone, .mdm-cal-done').first()
      .click({ force: true }).catch(e => console.log(`[post] cal-done click: ${e.message}`))
    await page.waitForTimeout(500)

    // Debug screenshot after calendar interaction
    await page.screenshot({ type: 'png', fullPage: true }).then(buf =>
      uploadToR2(`debug/post-${jobId}-datepicker-after.png`, buf, 'image/png')
    ).catch(() => {})

    // 3. Walls — open dropdown, check "Posts" (POSTS badge, not FOLLOWERS), click Done
    //    Use :not(#mdmCalDone) to avoid the calendar's Done button which stays in DOM (hidden)
    await page.locator('text=Select walls...').nth(0).click()
    await page.waitForTimeout(500)
    await page.locator('label', { hasText: 'Posts' }).filter({ hasNot: page.locator('text=FOLLOWERS') }).first().click()
    await page.waitForTimeout(300)
    await page.locator('button:has-text("Done"):not(#mdmCalDone)').first().click()
    await page.waitForTimeout(500)

    // 4. Media — upload video file
    const fileInput = page.locator('input[type="file"]').nth(0)
    await fileInput.setInputFiles(videoPath)
    await page.waitForTimeout(3000)

    // 5. Click "+ Schedule Post"
    await page.locator('button', { hasText: /Schedule Post/i }).nth(0).click()
    await page.waitForTimeout(2000)

    // 6. Check "Already Scheduled" tab for failures — send Telegram alert if any
    await page.locator('text=Already Scheduled').first().click()
    await page.waitForTimeout(2000)
    const failedTabText = await page.locator('text=/Failed\\s*\\(\\d+\\)/').first().textContent().catch(() => 'Failed (0)')
    const failedCount = parseInt(failedTabText?.match(/\((\d+)\)/)?.[1] ?? '0', 10)
    if (failedCount > 0) {
      await sendTelegram(`⚠️ FanCore posting error: ${failedCount} failed post(s) for @${handle}. Check Already Scheduled tab manually.`)
      throw new Error(`FanCore: ${failedCount} failed posts for @${handle}`)
    }

    // Mark posted in DB
    await supabaseAdmin.from('video_jobs').update({
      status: 'posted',
      scheduled_for: scheduledFor.toISOString(),
      posted_at: new Date().toISOString(),
    }).eq('id', jobId)

    console.log(`[post] ✓ Job ${jobId} posted — scheduled ${scheduledFor.toUTCString()}`)

  } catch (e) {
    const msg = (e as Error).message
    console.error(`[post] ✗ Failed ${jobId}:`, msg)
    // Revert to done so it can be retried
    await supabaseAdmin.from('video_jobs').update({
      status: 'done',
      error_message: `post failed: ${msg.slice(0, 400)}`,
    }).eq('id', jobId)
    throw e
  } finally {
    await browser.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
