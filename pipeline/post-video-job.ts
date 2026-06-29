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
import { getNextSlot, SLOT_INDEX } from '../lib/scheduling'

const BUCKET = process.env.R2_BUCKET_NAME ?? 'fansly-trends'
const FANCORE_URL = 'https://fancore-production.up.railway.app'
const SESSION_R2_KEY = 'sessions/fancore.json'

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



export async function postVideoJob(jobId: string, sharedBrowser?: Browser): Promise<void> {
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

  // Use pre-set scheduled_for if still in the future, otherwise compute the next free slot.
  const existingSlot = (job as unknown as { scheduled_for: string | null }).scheduled_for
  const existingDate = existingSlot ? new Date(existingSlot) : null
  let scheduledFor = existingDate && existingDate > new Date() ? existingDate : await getNextSlot(job.model_id)

  // Atomic claim: flip a postable job (approved/done) → posting only if we win the race (prevents
  // double-post), reserving the slot. If the slot collides with another active job (the unique index
  // rejects it — e.g. a re-post whose old slot is now taken), recompute getNextSlot and retry so two
  // videos never stack on one slot.
  let claimedPost: { id: string }[] | null = null
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, error } = await supabaseAdmin.from('video_jobs')
      .update({ status: 'posting', scheduled_for: scheduledFor.toISOString(), started_at: new Date().toISOString() })
      .eq('id', jobId)
      .in('status', ['approved', 'done'])
      .select('id')
    if (!error) { claimedPost = data as { id: string }[] | null; break }
    const detail = `${error.message} ${(error as { details?: string }).details ?? ''}`
    if (error.code === '23505' && detail.includes(SLOT_INDEX)) {
      scheduledFor = await getNextSlot(job.model_id)
      continue
    }
    console.error(`[post] ${jobId} claim error:`, error.message)
    return
  }
  if (!claimedPost || claimedPost.length === 0) {
    console.log(`[post] ${jobId} already claimed or not postable — skipping`)
    return
  }
  console.log(`[post] Scheduling job ${jobId} for @${handle} at ${scheduledFor.toUTCString()} (${existingSlot ? 'pre-set' : 'computed'})`)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc_post_'))

  // Browser launch is outside the main try block — wrap separately so EAGAIN failures
  // are caught, fail count is incremented, and the job exits 'posting' state cleanly.
  // Flags reduce Chrome sub-process count from ~9 to ~3 per instance:
  //   --no-zygote:    skip zygote broker (saves 1 process per Chrome)
  //   --disable-gpu:  skip GPU process (saves 1-2 processes; headless doesn't need GPU)
  let browser: Browser
  const ownsBrowser = !sharedBrowser || !sharedBrowser.isConnected()
  if (!ownsBrowser) {
    browser = sharedBrowser!
  } else {
    try {
      browser = await chromium.launch({
        headless: true,
        args: ['--no-zygote', '--disable-gpu'],
      })
    } catch (launchErr) {
      const msg = (launchErr as Error).message
      const { data: cur } = await supabaseAdmin.from('video_jobs').select('post_fail_count').eq('id', jobId).single()
      const failCount = ((cur as unknown as { post_fail_count: number } | null)?.post_fail_count ?? 0) + 1
      await supabaseAdmin.from('video_jobs').update({
        status: failCount >= 3 ? 'error' : 'done',
        post_fail_count: failCount,
        error_message: `post launch failed [${failCount}x]: ${msg.slice(0, 300)}`,
      }).eq('id', jobId)
      fs.rmSync(tmpDir, { recursive: true, force: true })
      throw launchErr
    }
  }

  // createContext (an R2 network call to load storageState) and newPage run BEFORE the main
  // try/finally — a throw here previously leaked the just-launched Chrome forever. Guard them
  // so the owned browser is always closed, mirroring the launch-failure handling above.
  // UTC timezone so 22:00 entered in date picker = 22:00 UTC
  let context: BrowserContext
  let page: Page
  try {
    context = (await createContext(browser)).context
    page = await context.newPage()
  } catch (setupErr) {
    if (ownsBrowser) await browser.close().catch(() => {})
    const msg = (setupErr as Error).message
    const { data: cur } = await supabaseAdmin.from('video_jobs').select('post_fail_count').eq('id', jobId).single()
    const failCount = ((cur as unknown as { post_fail_count: number } | null)?.post_fail_count ?? 0) + 1
    await supabaseAdmin.from('video_jobs').update({
      status: failCount >= 3 ? 'error' : 'done',
      post_fail_count: failCount,
      error_message: `post setup failed [${failCount}x]: ${msg.slice(0, 300)}`,
    }).eq('id', jobId)
    fs.rmSync(tmpDir, { recursive: true, force: true })
    throw setupErr
  }
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

  // Master timeout — MUST be shorter than the post cron's 5-min race (server.ts post cron).
  // Previously 12min: when the cron gave up at 5min it reset the job to 'approved' while THIS
  // call kept running for another 7min with its browser open, so the next tick picked the same
  // job up → duplicate Chrome instances (the process leak) and double-posts. At 4.5min the
  // worker self-aborts first: closing the context rejects the in-flight Playwright await, which
  // flows to the catch → post_fail_count++ → clean retry. Only close the full browser if owned.
  const masterTimer = setTimeout(() => {
    console.error('[post] ✗ Master 4.5-min timeout fired — closing context to abort')
    context.close().catch(() => {})
    if (ownsBrowser) browser.close().catch(() => {})
  }, 4.5 * 60_000)

  try {
    // Navigate to /bulk-posts and verify auth — storageState may have expired tokens.
    // FanCore doesn't always redirect to /signin on expiry — check for the sign-in form directly.
    await page.goto(`${FANCORE_URL}/bulk-posts`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const hasLoginForm = await page.locator('input[name="password"]').isVisible({ timeout: 3_000 }).catch(() => false)
    if (page.url().includes('/signin') || hasLoginForm) {
      console.log(`  ℹ Session expired (url=${page.url()}, loginForm=${hasLoginForm}) — logging in fresh`)
      await loginFanCore(page)
      await saveSession(page)
      await page.goto(`${FANCORE_URL}/bulk-posts`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    } else {
      console.log('  ✓ Session valid')
    }
    // Wait for sidebar models API call to complete after domcontentloaded
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})

    // Dismiss the "Renew subscription" lockOverlay if it appears.
    // FanCore auto-selects the last-used model on page load — if that model's subscription
    // is past due, a modal blocks all sidebar clicks until dismissed.
    const lockOverlay = page.locator('#lockOverlay[aria-hidden="false"]')
    if (await lockOverlay.isVisible({ timeout: 3_000 }).catch(() => false)) {
      console.log('[post] lockOverlay detected — clicking "Switch to another model"')
      await page.getByText('Switch to another model').first().click()
      await page.waitForTimeout(1_000)
    }

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
    // If the target model itself has a past-due subscription, another lockOverlay appears.
    if (await lockOverlay.isVisible({ timeout: 3_000 }).catch(() => false)) {
      throw new Error(`@${handle} subscription is past due on FanCore — cannot post, renew to unlock`)
    }
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

    // Wait for FanCore to ACTUALLY ATTACH the media before continuing. The upload is async; the old
    // fixed 5s wait submitted before it finished for anything slower → posts created with "0 media"
    // that FanCore then fails. Poll until a visible "1 media" shows for the slot (up to 90s). If it
    // never attaches, throw so the job retries instead of submitting an empty, media-less post.
    const mediaStart = Date.now()
    const mediaDeadline = mediaStart + 90_000
    let mediaAttached = false
    while (Date.now() < mediaDeadline && !mediaAttached) {
      await page.waitForTimeout(2000)
      mediaAttached = await page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        let node: Node | null
        while ((node = walker.nextNode())) {
          const text = (node.textContent ?? '').trim()
          // "1 media" = attached. "0 media" / "Uploading" = not yet (don't match those).
          if (/(^|[^0-9])1 media\b/.test(text) && (node as Text).parentElement?.offsetParent !== null) return true
        }
        return false
      }).catch(() => false)
    }
    const mediaWaited = Math.round((Date.now() - mediaStart) / 1000)
    console.log(`[post] media: uploadMethod=${uploadMethod} attached=${mediaAttached} after ${mediaWaited}s (${videoSizeMB}MB)`)
    console.log(`[post] media: WS=${JSON.stringify(wsLogs.slice(-10))} console=${JSON.stringify(pageConsoleLogs.slice(-5))}`)

    if (!mediaAttached) {
      await page.screenshot({ type: 'png', fullPage: true }).then(buf =>
        uploadToR2(`debug/post-${jobId}-media-failed.png`, buf, 'image/png')).catch(() => {})
      throw new Error(`media never attached after 90s (${videoSizeMB}MB) — not submitting an empty post`)
    }

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

    // Capture the SAVE response status — the authoritative signal that FanCore actually persisted
    // the post. The old code marked 'posted' on ANY observed POST and ignored the response, so a
    // rejected submit (or an unrelated POST) was still recorded as posted → "DB says posted but
    // it never posted". We gate the 'posted' write on this below.
    let saveStatus = 0
    let saveOk = false
    const responseListener = (resp: import('playwright').Response) => {
      if (resp.request().method() === 'POST' && /bulk-post/i.test(resp.url())) {
        saveStatus = resp.status()
        saveOk = resp.status() >= 200 && resp.status() < 300
      }
    }
    page.on('response', responseListener)

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
      const postFired = newRequests.some(r => r.startsWith('POST') && /bulk-post/i.test(r))
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

    // Fast-fail only on an EXPLICIT non-2xx create response. (A 2xx is NOT proof — FanCore returns
    // 200 and still silently drops posts; that was the phantom-'posted' bug.)
    if (saveStatus && !saveOk) {
      throw new Error(`FanCore rejected the post — save responded HTTP ${saveStatus}`)
    }

    // Honest verification: confirm THIS video's exact scheduled-slot timestamp actually appears in
    // FanCore's Already Scheduled list. The UTC browser context makes new Date(label).toISOString()
    // line up with scheduledFor.toISOString() (both at :00.000). Only THIS proves the post landed;
    // the 200 and the global "Scheduled (N)" count both lie. Not found → real failure → retry.
    const targetIso = scheduledFor.toISOString()
    console.log(`[post] verifying slot ${targetIso} landed on FanCore (max 60s)`)
    const pollDeadline = Date.now() + 60_000
    let landed = false
    while (Date.now() < pollDeadline && !landed) {
      try {
        await page.locator('text=Already Scheduled').first().click({ timeout: 3_000 })
        await page.waitForTimeout(1_500)
        let prevLen = -1
        for (let s = 0; s < 25 && !landed; s++) {
          landed = await page.evaluate((target: string) => {
            const datePattern = /\d{1,2}\/\d{1,2}\/\d{4},\s*\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)/
            const walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */)
            let node: Node | null
            while ((node = walker.nextNode())) {
              const m = ((node as Text).textContent ?? '').match(datePattern)
              if (m) { const d = new Date(m[0]); if (!isNaN(d.getTime()) && d.toISOString() === target) return true }
            }
            return false
          }, targetIso)
          if (landed) break
          const len = await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); return document.body.innerHTML.length })
          if (len === prevLen) break // no more cards lazy-loaded
          prevLen = len
          await page.waitForTimeout(500)
        }
      } catch { /* keep polling */ }
      if (!landed) await page.waitForTimeout(3_000)
    }
    page.off('response', responseListener)

    if (!landed) {
      await page.screenshot({ type: 'png', fullPage: true }).then(buf =>
        uploadToR2(`debug/post-${jobId}-notlanded.png`, buf, 'image/png')).catch(() => {})
      throw new Error(`post not on FanCore — slot ${targetIso} absent from Scheduled after 60s (saveStatus=${saveStatus || 'n/a'})`)
    }

    await supabaseAdmin.from('video_jobs').update({
      status: 'posted',
      scheduled_for: scheduledFor.toISOString(),
      posted_at: new Date().toISOString(),
    }).eq('id', jobId)
    console.log(`[post] ✓ Job ${jobId} VERIFIED on FanCore — slot ${targetIso}`)

  } catch (e) {
    const msg = (e as Error).message
    console.error(`[post] ✗ Failed ${jobId}:`, msg)
    const { data: cur } = await supabaseAdmin.from('video_jobs').select('post_fail_count').eq('id', jobId).single()
    const failCount = ((cur as unknown as { post_fail_count: number } | null)?.post_fail_count ?? 0) + 1
    await supabaseAdmin.from('video_jobs').update({
      status: failCount >= 3 ? 'error' : 'done',
      post_fail_count: failCount,
      error_message: `post failed [${failCount}x]: ${msg.slice(0, 400)}`,
    }).eq('id', jobId)
    throw e
  } finally {
    clearTimeout(masterTimer)
    await context.close().catch(() => {})
    if (ownsBrowser) await browser.close().catch(() => {})
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
