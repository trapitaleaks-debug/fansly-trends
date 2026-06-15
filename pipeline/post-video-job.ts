/**
 * FanCore auto-posting for content bank video jobs.
 * Called after a video_job renders successfully (status → done).
 * Schedules the post at 22:00 UTC — max 2 per day per model.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
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

// V1 formula: 5 Most Viewed + 3 Highest Impact + 2 Lowest Saturation = 10 total
// All pulled mechanically from fansly-tags.vercel.app — no Claude, no model-specific tags.
// V2 will layer in FanCore FYP Analytics → Tags (model-specific performance data).
async function selectHashtags(): Promise<string[]> {
  const FALLBACK = ['fansly', 'fyp', 'foryou', 'viral', 'model', 'subscribe', 'exclusive', 'content', 'creator', 'onlyfans']
  try {
    const res = await fetch('https://fansly-tags.vercel.app/api/tags', {
      headers: { 'Cache-Control': 'no-store' },
    } as RequestInit)
    if (!res.ok) throw new Error(`fansly-tags API ${res.status}`)
    const data = await res.json() as {
      mostViewed?: { tag: string }[]
      highestImpact?: { tag: string }[]
      lowestSaturation?: { tag: string }[]
    }

    const used = new Set<string>()
    const pickN = (list: { tag: string }[] | undefined, n: number): string[] => {
      const out: string[] = []
      for (const item of (list ?? [])) {
        if (out.length >= n) break
        const t = item.tag.toLowerCase()
        if (!BANNED_HASHTAGS.has(t) && !used.has(t)) { out.push(t); used.add(t) }
      }
      return out
    }

    const mostViewed     = pickN(data.mostViewed, 5)
    const highestImpact  = pickN(data.highestImpact, 3)
    const lowestSat      = pickN(data.lowestSaturation, 2)
    const tags = [...mostViewed, ...highestImpact, ...lowestSat]
    console.log(`[post] hashtags: mostViewed=[${mostViewed}] highestImpact=[${highestImpact}] lowestSat=[${lowestSat}]`)
    return tags.length === 10 ? tags : [...tags, ...FALLBACK].slice(0, 10)
  } catch (e) {
    console.error('[post] selectHashtags failed:', (e as Error).message)
    return FALLBACK
  }
}

async function downloadFromR2(key: string, destPath: string): Promise<void> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(new Error(`R2 download timed out: ${key}`)), 120_000)
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
      abortSignal: ac.signal,
    })
    const body = res.Body
    if (!body) throw new Error(`R2 key not found: ${key}`)
    const chunks: Uint8Array[] = []
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      if (ac.signal.aborted) throw ac.signal.reason
      chunks.push(chunk)
    }
    fs.writeFileSync(destPath, Buffer.concat(chunks))
  } finally {
    clearTimeout(t)
  }
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
    .select('id, model_id, output_r2_key, trends_models(fansly_username)')
    .eq('id', jobId)
    .single()

  if (jobErr || !job) throw new Error(`postVideoJob: job not found — ${jobErr?.message}`)
  if (!job.output_r2_key) throw new Error(`postVideoJob: no output_r2_key for job ${jobId}`)

  const modelMeta = (job as unknown as { trends_models: { fansly_username: string } | null }).trends_models
  if (!modelMeta) throw new Error(`postVideoJob: no model data for job ${jobId}`)

  const handle = modelMeta.fansly_username

  const selectedHashtags = await selectHashtags()
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
  page.setDefaultTimeout(60_000)
  page.setDefaultNavigationTimeout(30_000)

  // NOTE: addInitScript fetch/XHR patching was removed — it broke FanCore's drag-and-drop
  // handler. The slot state was never set when window.fetch was monkey-patched before page load,
  // causing the per-slot submit button to be a no-op (no post created at all).

  // Capture ALL WebSocket frames — FanCore may upload file data via WS binary frames.
  const wsLogs: string[] = []
  page.on('websocket', ws => {
    wsLogs.push(`OPEN:${ws.url().slice(0, 80)}`)
    ws.on('framesent', f => {
      const p = f.payload
      const size = typeof p === 'string' ? p.length : ((p as any)?.byteLength ?? 0)
      const preview = typeof p === 'string' ? p.slice(0, 80) : `[binary:${size}b]`
      wsLogs.push(`SENT:${preview}`)
    })
    ws.on('framereceived', f => {
      const p = f.payload
      const size = typeof p === 'string' ? p.length : ((p as any)?.byteLength ?? 0)
      const preview = typeof p === 'string' ? p.slice(0, 80) : `[binary:${size}b]`
      wsLogs.push(`RECV:${preview}`)
    })
  })

  // Capture page console output — FanCore may log upload progress or errors.
  const pageConsoleLogs: string[] = []
  page.on('console', msg => {
    pageConsoleLogs.push(`${msg.type()}:${msg.text().slice(0, 150)}`)
  })
  page.on('pageerror', err => {
    pageConsoleLogs.push(`PAGEERR:${err.message.slice(0, 150)}`)
  })

  // Master 12-minute timeout — if anything hangs (R2 stall, Playwright deadlock), close the browser
  // Budget: R2 download (2min) + upload wait (1.5min) + form fill (1min) + verify (1min) + buffer
  const masterTimer = setTimeout(() => {
    console.error('[post] ✗ Master 12-min timeout fired — closing browser')
    browser.close().catch(() => {})
  }, 12 * 60_000)

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

    // 2. Schedule for — the "Schedule for" field is input.schedule-input[type="datetime-local"].
    //    Fill it directly with the UTC datetime in YYYY-MM-DDTHH:MM format.
    //    (Browser context is already set to UTC so no timezone offset needed.)
    const yyyy = scheduledFor.getUTCFullYear()
    const mm = String(scheduledFor.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(scheduledFor.getUTCDate()).padStart(2, '0')
    const hh = String(scheduledFor.getUTCHours()).padStart(2, '0')
    const min = String(scheduledFor.getUTCMinutes()).padStart(2, '0')
    const dtValue = `${yyyy}-${mm}-${dd}T${hh}:${min}`
    const schedInput = page.locator('input.schedule-input[type="datetime-local"]').nth(0)
    await schedInput.fill(dtValue)
    console.log(`[post] schedule-input filled: ${dtValue}`)
    await page.waitForTimeout(300)

    // 3. Walls — open dropdown, select Posts, click Done
    //    If already pre-selected (no "Select walls..." text), skip opening the dropdown
    const wallsDropdown = page.locator('text=Select walls...').nth(0)
    const wallsNeedsOpen = await wallsDropdown.isVisible({ timeout: 3000 }).catch(() => false)
    if (wallsNeedsOpen) {
      await wallsDropdown.click()
      await page.waitForTimeout(500)
      await page.locator('label', { hasText: 'Posts' }).filter({ hasNot: page.locator('text=FOLLOWERS') }).first().click()
      await page.waitForTimeout(300)
      await page.locator('button:has-text("Done"):not(#mdmCalDone)').first().click()
      await page.waitForTimeout(500)
      console.log('[post] walls: opened dropdown and selected Posts')
    } else {
      console.log('[post] walls: already pre-selected, skipping dropdown')
    }

    // 4. Media — two-step:
    //    (A) Drag-and-drop: activates the slot's media state (submit creates the post).
    //        setInputFiles directly on any input doesn't activate slot state (tested: no-op at submit).
    //    (B) Filechooser fallback.
    //    FC-FETCH/FC-XHR/WS interceptors (added at addInitScript above) capture what happens at submit.
    let uploadMethod = 'none'
    const videoName = path.basename(videoPath)
    const videoSizeMB = Math.round(fs.statSync(videoPath).size / 1024 / 1024)
    console.log(`[post] media: uploading ${videoName} (${videoSizeMB}MB)`)

    const fakeUrl = 'https://media-upload-local.internal/upload.mp4'
    await page.route(fakeUrl, async route => {
      const buffer = fs.readFileSync(videoPath)
      await route.fulfill({
        status: 200,
        contentType: 'video/mp4',
        headers: { 'Content-Length': String(buffer.length), 'Access-Control-Allow-Origin': '*' },
        body: buffer,
      })
    })

    try {
      const dataTransfer = await page.evaluateHandle(async ([url, name]: [string, string]) => {
        const res = await fetch(url)
        const buf = await res.arrayBuffer()
        const file = new File([buf], name, { type: 'video/mp4' })
        const dt = new DataTransfer()
        dt.items.add(file)
        return dt
      }, [fakeUrl, videoName] as [string, string])

      await page.unroute(fakeUrl)

      const dropZone = page.locator('text=/[Dd]rop media/').first()
      await dropZone.waitFor({ state: 'visible', timeout: 10000 })
      await dropZone.dispatchEvent('dragenter', { dataTransfer })
      await page.waitForTimeout(100)
      await dropZone.dispatchEvent('dragover', { dataTransfer })
      await page.waitForTimeout(100)
      await dropZone.dispatchEvent('drop', { dataTransfer })
      uploadMethod = 'drag-and-drop'
      console.log('[post] media: drag-and-drop dispatched')
    } catch (dndErr) {
      await page.unroute(fakeUrl).catch(() => {})
      console.log(`[post] media: drag-and-drop failed (${(dndErr as Error).message}) — trying filechooser`)
      try {
        const [fileChooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 10000 }),
          page.locator('text=/[Dd]rop media|[Cc]lick to upload/').first().click(),
        ])
        await fileChooser.setFiles(videoPath)
        uploadMethod = 'filechooser'
        console.log('[post] media: filechooser setFiles called')
      } catch (fcErr) {
        console.log(`[post] media: filechooser also failed: ${(fcErr as Error).message}`)
      }
    }

    // Wait 10s to catch any pre-upload the slot triggers after file attachment
    await page.waitForTimeout(10000)

    // Diagnostic: check file input state and fetch/WS logs BEFORE submit
    const fileInputState = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[type="file"]')).map((i) => ({
        id: (i as HTMLInputElement).id,
        cls: (i as HTMLInputElement).className.slice(0, 60),
        filesCount: (i as HTMLInputElement).files?.length ?? 0,
        fileName: (i as HTMLInputElement).files?.[0]?.name ?? 'none',
      }))
    ).catch(() => [])
    console.log(`[post] media: file input state: ${JSON.stringify(fileInputState)}`)
    console.log(`[post] media: WS logs after select: ${JSON.stringify(wsLogs)}`)
    console.log(`[post] media: page console after select: ${JSON.stringify(pageConsoleLogs.slice(-10))}`)

    // Check whether the slot shows media preview — use visible-only check to avoid false positives
    // from Already Scheduled tab entries in the DOM.
    const mediaPreviewVisible = await page.locator('[class*="selected-media"], [class*="media-preview"], [class*="medias"] video, [class*="medias"] img').first().isVisible().catch(() => false)
    const slotCardText = await page.locator('[class*="bulk-slot"], [class*="slot-card"], .slot-wrapper').first().innerText().catch(() => '')
    console.log(`[post] media: preview visible: ${mediaPreviewVisible}, slot text: ${slotCardText.slice(0, 200)}`)

    // Screenshot after upload to verify media was attached
    await page.screenshot({ type: 'png', fullPage: false }).then(buf =>
      uploadToR2(`debug/post-${jobId}-after-upload.png`, buf, 'image/png')
    ).catch(() => {})

    // Full-page screenshot before submit
    await page.screenshot({ type: 'png', fullPage: true }).then(buf =>
      uploadToR2(`debug/post-${jobId}-before-submit.png`, buf, 'image/png')
    ).catch(() => {})

    // 5. Find and click the per-slot "Schedule Post" submit button.
    //    Dump all matching buttons first so we can diagnose selector issues.
    const schedBtns = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button')).filter(b => {
        const t = b.textContent?.toLowerCase() ?? ''
        return t.includes('schedule') || t.includes('post')
      }).map(b => ({ text: b.textContent?.trim().slice(0, 50), cls: b.className, id: b.id, visible: b.offsetParent !== null }))
    }).catch(() => [])
    console.log(`[post] schedule buttons: ${JSON.stringify(schedBtns)}`)

    // Use the PER-SLOT "Schedule Post" button (class contains "bulk-submit-btn"), NOT the global
    // bulkSubmitBtn (which submits all slots and requires all slots to be filled).
    // The per-slot button is the first button with class "bulk-submit-btn" in the DOM.
    const submitBtn = await (async () => {
      // Primary: per-slot button identified by class — skip the global bulkSubmitBtn
      const perSlot = page.locator('button[class*="bulk-submit-btn"]')
      if (await perSlot.count() > 0) {
        console.log(`[post] submit: using per-slot bulk-submit-btn (${await perSlot.count()} found)`)
        return perSlot.first()
      }
      // Fallback 1: second "Schedule Post" (nth(1) skips global bulkSubmitBtn, gets slot 1 button)
      const exact = page.locator('button').filter({ hasText: /^Schedule Post$/ })
      const cnt = await exact.count()
      if (cnt > 1) {
        console.log(`[post] submit: using nth(1) of ${cnt} Schedule Post buttons`)
        return exact.nth(1)
      }
      // Fallback 2: any "Schedule Post" button
      if (cnt > 0) return exact.nth(0)
      return page.locator('button', { hasText: /Schedule Post/i }).nth(0)
    })()
    const wsLogsBeforeSubmit = wsLogs.length

    // Monitor ALL HTTP requests during submit — captures file upload URL if FanCore does it at submit time
    const submitRequests: string[] = []
    const submitListener = (req: any) => {
      submitRequests.push(`${req.method()} ${req.url().slice(0, 140)}`)
    }
    page.on('request', submitListener)

    await submitBtn.click()
    console.log('[post] submit clicked — waiting for FanCore upload (90s)')

    await page.waitForTimeout(90000)

    page.off('request', submitListener)

    const wsLogsAfterSubmit = wsLogs.slice(wsLogsBeforeSubmit)
    const postPutRequests = submitRequests.filter(r => r.startsWith('POST') || r.startsWith('PUT'))
    console.log(`[post] submit: POST/PUT HTTP: ${JSON.stringify(postPutRequests)}`)
    console.log(`[post] submit: new WS logs: ${JSON.stringify(wsLogsAfterSubmit.slice(-30))}`)
    console.log(`[post] submit: page console: ${JSON.stringify(pageConsoleLogs.slice(-15))}`)

    // 6. Check "Already Scheduled" tab — count total posts before/after to verify our post was added
    await page.locator('text=Already Scheduled').first().click()
    await page.waitForTimeout(2000)

    // Screenshot after navigating to Already Scheduled
    await page.screenshot({ type: 'png', fullPage: true }).then(buf =>
      uploadToR2(`debug/post-${jobId}-already-scheduled.png`, buf, 'image/png')
    ).catch(() => {})

    const allTabText = await page.locator('text=/All\\s*\\(\\d+\\)/').first().textContent().catch(() => 'All (0)')
    const scheduledTabText = await page.locator('text=/Scheduled\\s*\\(\\d+\\)/').first().textContent().catch(() => 'Scheduled (0)')
    const failedTabText = await page.locator('text=/Failed\\s*\\(\\d+\\)/').first().textContent().catch(() => 'Failed (0)')
    const allCount = parseInt(allTabText?.match(/\((\d+)\)/)?.[1] ?? '0', 10)
    const scheduledCount = parseInt(scheduledTabText?.match(/\((\d+)\)/)?.[1] ?? '0', 10)
    const failedCount = parseInt(failedTabText?.match(/\((\d+)\)/)?.[1] ?? '0', 10)
    console.log(`[post] Already Scheduled: All=${allCount} Scheduled=${scheduledCount} Failed=${failedCount}`)

    if (failedCount > 0) {
      await sendTelegram(`⚠️ FanCore posting error: ${failedCount} failed post(s) for @${handle}. Check Already Scheduled tab manually.`)
      throw new Error(`FanCore: ${failedCount} failed posts for @${handle}`)
    }
    // Require at least 1 Scheduled post — Sent posts are already published and don't count
    if (scheduledCount === 0) {
      throw new Error(`FanCore: no Scheduled post found after submit (All=${allCount} Scheduled=0) — post was not created. Check after-upload + already-scheduled debug screenshots.`)
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
    clearTimeout(masterTimer)
    await browser.close().catch(() => {})
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
