/**
 * FanCore auto-posting for content bank video jobs.
 * Called after a video_job renders successfully (status → done).
 * Schedules 4 posts per day per model at random times between 8:00–23:00 UTC.
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
// Slot system: 4 posts per day per model at random times between 8:00–23:00 UTC.
// Each slot is spaced at least 30 min from others on the same day.
// Videos fill slots sequentially across models — next available slot on the earliest day with < 4 posts.
const SLOTS_PER_DAY        = 4
const SLOT_WINDOW_START    = 8   // earliest hour (UTC)
const SLOT_WINDOW_END      = 23  // latest hour (UTC)
const SLOT_MIN_GAP_MS      = 30 * 60 * 1000  // 30-min minimum gap between slots on same day


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

// Returns the next available random slot datetime for this model.
// Picks a random time in [SLOT_WINDOW_START, SLOT_WINDOW_END] UTC, at least SLOT_MIN_GAP_MS
// away from all other slots already scheduled for the same day.
async function getNextSlot(modelId: string): Promise<Date> {
  const { data } = await supabaseAdmin
    .from('video_jobs')
    .select('scheduled_for')
    .eq('model_id', modelId)
    .not('scheduled_for', 'is', null)
    .gte('scheduled_for', new Date().toISOString())

  // Group existing future slots by calendar day (UTC)
  const slotsByDay = new Map<string, Date[]>()
  for (const row of (data ?? [])) {
    const d = new Date(row.scheduled_for)
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
    if (!slotsByDay.has(key)) slotsByDay.set(key, [])
    slotsByDay.get(key)!.push(d)
  }

  const now = new Date()

  for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
    const y = now.getUTCFullYear(), mo = now.getUTCMonth(), d = now.getUTCDate() + dayOffset
    const dayKey = `${y}-${mo}-${d}`
    const taken = slotsByDay.get(dayKey) ?? []
    if (taken.length >= SLOTS_PER_DAY) continue

    // Try up to 40 random times in the day window
    for (let attempt = 0; attempt < 40; attempt++) {
      const rangeHours = SLOT_WINDOW_END - SLOT_WINDOW_START
      const hour   = SLOT_WINDOW_START + Math.floor(Math.random() * (rangeHours + 1))
      const minute = Math.floor(Math.random() * 60)
      const candidate = new Date(Date.UTC(y, mo, d, hour, minute, 0, 0))

      if (candidate <= now) continue
      const tooClose = taken.some(s => Math.abs(s.getTime() - candidate.getTime()) < SLOT_MIN_GAP_MS)
      if (tooClose) continue

      return candidate
    }
    // Day exhausted (extremely unlikely with 4 slots in a 15h window) — try next day
  }

  // Hard fallback
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 12, 0, 0, 0))
}

export async function postVideoJob(jobId: string): Promise<void> {
  // Load job + model
  const { data: job, error: jobErr } = await supabaseAdmin
    .from('video_jobs')
    .select('id, model_id, output_r2_key, scheduled_for, trends_models(fansly_username)')
    .eq('id', jobId)
    .single()

  if (jobErr || !job) throw new Error(`postVideoJob: job not found — ${jobErr?.message}`)
  if (!job.output_r2_key) throw new Error(`postVideoJob: no output_r2_key for job ${jobId}`)

  const modelMeta = (job as unknown as { trends_models: { fansly_username: string } | null }).trends_models
  if (!modelMeta) throw new Error(`postVideoJob: no model data for job ${jobId}`)

  const handle = modelMeta.fansly_username

  // Use pre-set scheduled_for if already computed, otherwise calculate the next slot
  const existingSlot = (job as unknown as { scheduled_for: string | null }).scheduled_for
  const scheduledFor = existingSlot ? new Date(existingSlot) : await getNextSlot(job.model_id)
  console.log(`[post] Scheduling job ${jobId} for @${handle} at ${scheduledFor.toUTCString()} (${existingSlot ? 'pre-set' : 'computed'})`)

  // Reserve slot in DB immediately — before browser launch — so concurrent calls see it
  await supabaseAdmin.from('video_jobs').update({ status: 'posting', scheduled_for: scheduledFor.toISOString() }).eq('id', jobId)

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

    // ─── All fields scoped to slot 1's <form> ──────────────────────────────────
    // Root cause of prior failures: page.locator(...).nth(0) can target a DIFFERENT
    // form's input than the one that owns the submit button. FormData(form) only reads
    // inputs inside the form's DOM subtree — if the date input is in a different form,
    // fd.get('scheduled_at') returns null and FanCore shows "Pick a date/time first."
    const slotForm = page.locator('form').filter({ has: page.locator('button.bulk-submit-btn') }).first()
    const schedInput  = slotForm.locator('input[name="scheduled_at"]')
    const captionInput = slotForm.locator('textarea[name="caption"]')
    const fileInput   = slotForm.locator('input.bulk-file-input')
    const submitBtn   = slotForm.locator('button.bulk-submit-btn')

    // 1. Hashtags — type "hey" in caption to give the generator context, click generate,
    //    wait for tags to populate, then clear the caption so the post has hashtags only.
    await captionInput.fill('hey')
    await captionInput.evaluate((el: Element) => el.dispatchEvent(new Event('input', { bubbles: true })))
    await page.waitForTimeout(200)
    await slotForm.locator('button.bulk-regen-tags').click()
    console.log('[post] hashtags: generate button clicked')
    // Poll until tags field is non-empty (up to 20s)
    const tagsPopulated = await page.waitForFunction(
      () => (document.querySelectorAll('input[name="tags"]')[0] as HTMLInputElement)?.value?.trim().length > 0,
      { timeout: 20000 }
    ).then(() => true).catch(() => false)
    const generatedTags = await slotForm.locator('input[name="tags"]').inputValue().catch(() => '')
    console.log(`[post] hashtags: populated=${tagsPopulated} tags="${generatedTags}"`)
    // Clear caption — post with hashtags only
    await captionInput.fill('')
    await captionInput.evaluate((el: Element) => el.dispatchEvent(new Event('input', { bubbles: true })))

    // 2. Schedule date — fill + dispatch change so FanCore's closure sees it
    const yyyy = scheduledFor.getUTCFullYear()
    const mm   = String(scheduledFor.getUTCMonth() + 1).padStart(2, '0')
    const dd   = String(scheduledFor.getUTCDate()).padStart(2, '0')
    const hh   = String(scheduledFor.getUTCHours()).padStart(2, '0')
    const min  = String(scheduledFor.getUTCMinutes()).padStart(2, '0')
    const dtValue = `${yyyy}-${mm}-${dd}T${hh}:${min}`
    await schedInput.fill(dtValue)
    await schedInput.evaluate((el: Element) => el.dispatchEvent(new Event('change', { bubbles: true })))
    await page.waitForTimeout(200)
    console.log(`[post] schedule-input filled: ${dtValue} actual="${await schedInput.inputValue().catch(() => '')}"`)

    // 3. Walls — open dropdown, select Posts, click Done
    const wallsDropdown = slotForm.locator('text=Select walls...').first()
    const wallsNeedsOpen = await wallsDropdown.isVisible({ timeout: 3000 }).catch(() => false)
    if (wallsNeedsOpen) {
      await wallsDropdown.click()
      await page.waitForTimeout(500)
      await page.locator('label', { hasText: 'Posts' }).filter({ hasNot: page.locator('text=FOLLOWERS') }).first().click()
      await page.waitForTimeout(300)
      await page.locator('button:has-text("Done"):not(#mdmCalDone)').first().click()
      await page.waitForTimeout(500)
      console.log('[post] walls: selected Posts')
    } else {
      console.log('[post] walls: pre-selected')
    }

    // Re-fill date after walls (dropdown re-render may reset the field)
    await schedInput.fill(dtValue)
    await schedInput.evaluate((el: Element) => el.dispatchEvent(new Event('change', { bubbles: true })))
    await page.waitForTimeout(200)
    const dateAfterWalls = await schedInput.inputValue().catch(() => '')
    console.log(`[post] schedule-input after walls: "${dateAfterWalls}" (expected "${dtValue}")`)

    // 4. Media — setInputFiles on the form-scoped file input
    const videoName = path.basename(videoPath)
    const videoSizeMB = Math.round(fs.statSync(videoPath).size / 1024 / 1024)
    console.log(`[post] media: uploading ${videoName} (${videoSizeMB}MB)`)

    let uploadMethod = 'none'
    try {
      await fileInput.setInputFiles(videoPath)
      uploadMethod = 'slot-input-setInputFiles'
      console.log('[post] media: setInputFiles called')
    } catch (e) {
      console.log(`[post] media: setInputFiles failed: ${(e as Error).message}`)
    }

    // Fallback: filechooser
    if (uploadMethod === 'none') {
      try {
        const [fc] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 10000 }),
          slotForm.locator('text=/[Dd]rop media|[Cc]lick to upload/').first().click(),
        ])
        await fc.setFiles(videoPath)
        uploadMethod = 'filechooser'
        console.log('[post] media: filechooser setFiles called')
      } catch (fcErr) {
        console.log(`[post] media: filechooser failed: ${(fcErr as Error).message}`)
      }
    }

    // Wait for FanCore to process the file (change handler → addFiles → refreshDropText)
    await page.waitForTimeout(5000)

    // Verify "Selected Media (1)" is visible in the DOM
    const mediaTextElements = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      const results: Array<{text: string; visible: boolean}> = []
      let node: Node | null
      while ((node = walker.nextNode())) {
        const text = (node.textContent ?? '').trim()
        if (text.includes('1 media') || text.includes('Selected Media')) {
          const el = (node as Text).parentElement
          if (el) results.push({ text: text.slice(0, 60), visible: el.offsetParent !== null })
        }
      }
      return results
    }).catch(() => [])
    console.log(`[post] media: uploadMethod=${uploadMethod} mediaText=${JSON.stringify(mediaTextElements)}`)
    console.log(`[post] media: WS=${JSON.stringify(wsLogs)} console=${JSON.stringify(pageConsoleLogs.slice(-5))}`)

    // Screenshots for debugging
    await page.screenshot({ type: 'png' }).then(buf =>
      uploadToR2(`debug/post-${jobId}-after-upload.png`, buf, 'image/png')
    ).catch(() => {})
    await page.screenshot({ type: 'png', fullPage: true }).then(buf =>
      uploadToR2(`debug/post-${jobId}-before-submit.png`, buf, 'image/png')
    ).catch(() => {})

    // ─── Pre-submit: verify FormData sees all required fields ──────────────────
    const preCheck = await submitBtn.evaluate((btn: Element, dtVal: string) => {
      const form = (btn as HTMLButtonElement).closest('form') as HTMLFormElement | null
      if (!form) return { error: 'no form found' }
      const fd = new FormData(form)
      const schedInp = form.querySelector('input[name="scheduled_at"]') as HTMLInputElement | null
      return {
        scheduledAt: String(fd.get('scheduled_at') ?? ''),
        tags: String(fd.get('tags') ?? ''),
        schedValue: schedInp?.value ?? '',
        btnDisabled: (btn as HTMLButtonElement).disabled,
        statusText: (form.querySelector('.bulk-form-status') as HTMLElement)?.textContent?.trim() ?? '',
      }
    }, dtValue).catch((e: Error) => ({ evalError: e.message }))
    console.log(`[post] pre-submit FormData: ${JSON.stringify(preCheck)}`)

    // If scheduled_at still empty, inject via native value setter (bypasses framework guards)
    const preCheckAny = preCheck as Record<string, unknown>
    if (!preCheckAny.evalError && !preCheckAny.schedValue) {
      console.log('[post] schedValue empty — injecting via nativeInputValueSetter')
      await submitBtn.evaluate((btn: Element, dtVal: string) => {
        const form = (btn as HTMLButtonElement).closest('form')!
        const inp = form.querySelector('input[name="scheduled_at"]') as HTMLInputElement
        if (inp) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
          setter.call(inp, dtVal)
          inp.dispatchEvent(new Event('input', { bubbles: true }))
          inp.dispatchEvent(new Event('change', { bubbles: true }))
        }
      }, dtValue)
      await page.waitForTimeout(300)
    }

    // ─── Self-verifying submit loop ────────────────────────────────────────────
    // Reads .bulk-form-status after each click to detect validation errors and fix them.
    // Confirms success only when a real POST to /api/bulk-posts/pending is observed.
    const submitRequests: string[] = []
    const submitListener = (req: import('playwright').Request) => {
      submitRequests.push(`${req.method()} ${req.url().slice(0, 140)}`)
    }
    page.on('request', submitListener)

    let postObserved = false
    let submitAttempts = 0

    while (!postObserved && submitAttempts < 5) {
      submitAttempts++
      const reqsBefore = submitRequests.length

      // Escalating click strategies
      if (submitAttempts === 1) {
        await submitBtn.click()
      } else if (submitAttempts === 2) {
        // requestSubmit() dispatches the submit event directly from the form element
        await submitBtn.evaluate((btn: Element) => {
          const form = (btn as HTMLButtonElement).closest('form')
          if (form) (form as HTMLFormElement).requestSubmit()
        })
      } else {
        const box = await submitBtn.boundingBox()
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        else await submitBtn.click()
      }

      await page.waitForTimeout(2000)

      // Read validation banner and new POST requests
      const statusText = await slotForm.locator('.bulk-form-status').textContent().catch(() => '')
      const newRequests = submitRequests.slice(reqsBefore)
      const postFired = newRequests.some(r => r.startsWith('POST'))
      console.log(`[post] attempt ${submitAttempts}: status="${statusText}" newPOSTs=${JSON.stringify(newRequests.filter(r => r.startsWith('POST')))}`)

      if (postFired) {
        postObserved = true
        console.log(`[post] ✓ POST confirmed on attempt ${submitAttempts}`)
        break
      }

      // Diagnose and fix
      if (statusText && /date|time|pick a date/i.test(statusText)) {
        console.log('[post] → date validation error — re-injecting scheduled_at via JS')
        await submitBtn.evaluate((btn: Element, dtVal: string) => {
          const form = (btn as HTMLButtonElement).closest('form')!
          const inp = form.querySelector('input[name="scheduled_at"]') as HTMLInputElement
          if (inp) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
            setter.call(inp, dtVal)
            inp.dispatchEvent(new Event('input', { bubbles: true }))
            inp.dispatchEvent(new Event('change', { bubbles: true }))
          }
        }, dtValue)
        await page.waitForTimeout(300)
      } else if (statusText && /caption|media|add a caption/i.test(statusText)) {
        console.log('[post] → media validation error — re-uploading file')
        await fileInput.setInputFiles(videoPath)
        await page.waitForTimeout(3000)
      }

      await page.waitForTimeout(500)
    }

    page.off('request', submitListener)
    console.log(`[post] submit: all POST/PUT=${JSON.stringify(submitRequests.filter(r => r.startsWith('POST') || r.startsWith('PUT')))}`)
    console.log(`[post] submit: WS=${JSON.stringify(wsLogs.slice(-15))} console=${JSON.stringify(pageConsoleLogs.slice(-10))}`)

    if (!postObserved) {
      await page.screenshot({ type: 'png', fullPage: true }).then(buf =>
        uploadToR2(`debug/post-${jobId}-submit-failed.png`, buf, 'image/png')
      ).catch(() => {})
      throw new Error(`FanCore: no POST to /api/bulk-posts/pending after ${submitAttempts} attempts — see debug/post-${jobId}-submit-failed.png`)
    }

    // POST confirmed — wait for FanCore to finish uploading the video file
    console.log('[post] POST confirmed — waiting up to 90s for upload to complete')
    await page.waitForTimeout(90000)

    // 6. Verify in Already Scheduled tab
    await page.locator('text=Already Scheduled').first().click()
    await page.waitForTimeout(2000)
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
      await sendTelegram(`⚠️ FanCore posting error: ${failedCount} failed post(s) for @${handle}. Check Already Scheduled tab.`)
      throw new Error(`FanCore: ${failedCount} failed posts for @${handle}`)
    }
    if (scheduledCount === 0) {
      throw new Error(`FanCore: no Scheduled post after submit (All=${allCount} Scheduled=0) — check already-scheduled debug screenshot`)
    }

    // Mark posted
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
