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

    // Find all elements with onclick handlers containing 'cal' or 'Cal', and all inputs near
    // the "Schedule for" label, to identify the calendar trigger. Log them for debugging.
    const triggerInfo = await page.evaluate(() => {
      const results: Array<{tag: string; id: string; cls: string; onclick: string; type?: string; placeholder?: string; text?: string}> = []
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const onclick = el.getAttribute('onclick') ?? ''
        if (onclick && (onclick.toLowerCase().includes('cal') || onclick.toLowerCase().includes('date'))) {
          results.push({ tag: el.tagName, id: el.id, cls: (el as Element).className, onclick })
        }
      }
      // Also find all visible inputs in the form
      for (const el of Array.from(document.querySelectorAll('input'))) {
        const rect = el.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          results.push({ tag: 'INPUT', id: el.id, cls: el.className, onclick: el.getAttribute('onclick') ?? '', type: el.type, placeholder: el.placeholder })
        }
      }
      return results
    }).catch(() => [])
    console.log(`[post] trigger candidates: ${JSON.stringify(triggerInfo).slice(0, 2000)}`)

    // The calendar trigger is the input that shows the current date value and opens #mdmCal.
    // Try: find any visible <input> that has an onclick pointing to the calendar, or
    // find the element immediately before #mdmCal in the DOM.
    const calTrigger = await page.evaluate(() => {
      const cal = document.getElementById('mdmCal')
      if (!cal) return null
      // Walk backwards in DOM siblings to find the trigger
      let prev = cal.previousElementSibling
      while (prev) {
        const tag = prev.tagName.toLowerCase()
        if (tag === 'input' || tag === 'button' || prev.getAttribute('role') === 'button') {
          return { tag: prev.tagName, id: prev.id, cls: (prev as Element).className, onclick: prev.getAttribute('onclick') }
        }
        // Check children of prev
        const inp = prev.querySelector('input, button')
        if (inp) return { tag: inp.tagName, id: inp.id, cls: inp.className, onclick: inp.getAttribute('onclick') }
        prev = prev.previousElementSibling
      }
      return null
    }).catch(() => null)
    console.log(`[post] cal trigger element: ${JSON.stringify(calTrigger)}`)

    // Open calendar: click trigger or force-open via JS
    await page.evaluate(() => {
      // Find all elements with onclick that reference the calendar
      for (const el of Array.from(document.querySelectorAll('[onclick*="Cal"], [onclick*="cal"], [data-target="#mdmCal"]'))) {
        (el as HTMLElement).click()
        return
      }
      // Fallback: click the input immediately before #mdmCal
      const cal = document.getElementById('mdmCal')
      if (!cal) return
      let prev = cal.previousElementSibling
      while (prev) {
        const clickable = prev.querySelector('input, button') ?? (prev.tagName === 'INPUT' || prev.tagName === 'BUTTON' ? prev : null)
        if (clickable) { (clickable as HTMLElement).click(); return }
        prev = prev.previousElementSibling
      }
    }).catch(() => {})
    await page.waitForTimeout(1200)

    // Screenshot after attempting to open calendar
    await page.screenshot({ type: 'png', fullPage: true }).then(buf =>
      uploadToR2(`debug/post-${jobId}-datepicker.png`, buf, 'image/png')
    ).catch(() => {})

    // Check if calendar opened (hidden attribute removed from #mdmCal)
    const calOpen = await page.evaluate(() => {
      const cal = document.getElementById('mdmCal')
      return cal ? !cal.hasAttribute('hidden') : false
    }).catch(() => false)
    console.log(`[post] calendar opened: ${calOpen}`)

    if (!calOpen) {
      // Force open via JS — remove hidden and manually init grid
      await page.evaluate((day: number) => {
        const cal = document.getElementById('mdmCal')
        if (!cal) return
        cal.removeAttribute('hidden')
        // Try clicking the trigger button to fire its event handler
        const btn = cal.previousElementSibling?.querySelector('input, button, [role="button"]')
        if (btn) (btn as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
      }, targetDay).catch(() => {})
      await page.waitForTimeout(800)
    }

    // Click the day in #mdmCalGrid (buttons injected by JS when calendar opens)
    // Wait up to 5s for the grid to be populated
    await page.waitForSelector(`#mdmCalGrid button`, { timeout: 5000 }).catch(() => {})
    const dayClicked = await page.evaluate((day: number) => {
      const buttons = Array.from(document.querySelectorAll('#mdmCalGrid button'))
      const target = buttons.find(b => b.textContent?.trim() === String(day) && !b.classList.contains('mdm-cal-other') && !b.hasAttribute('disabled'))
      if (target) { (target as HTMLElement).click(); return true }
      return false
    }, targetDay).catch(() => false)
    console.log(`[post] day ${targetDay} clicked: ${dayClicked}`)
    await page.waitForTimeout(400)

    // Set hour = 22 via select dropdown #mdmCalHour
    await page.selectOption('#mdmCalHour', '22').catch(async () => {
      await page.evaluate(() => {
        const sel = document.getElementById('mdmCalHour') as HTMLSelectElement | null
        if (sel) { sel.value = '22'; sel.dispatchEvent(new Event('change', { bubbles: true })) }
      })
    })
    await page.waitForTimeout(200)

    // Set minute = 00 via select dropdown #mdmCalMin
    await page.selectOption('#mdmCalMin', '0').catch(async () => {
      await page.evaluate(() => {
        const sel = document.getElementById('mdmCalMin') as HTMLSelectElement | null
        if (sel) { sel.value = '0'; sel.dispatchEvent(new Event('change', { bubbles: true })) }
      })
    })
    await page.waitForTimeout(200)

    // Click Done button to confirm
    await page.click('#mdmCalDone').catch(async (e) => {
      console.log(`[post] Done click error: ${e.message}`)
      await page.evaluate(() => { (document.getElementById('mdmCalDone') as HTMLElement | null)?.click() })
    })
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
