/**
 * On-demand Fansly native scheduled-posts monitor (Wave C+).
 *
 * Logs into each model's own Fansly account, navigates to fansly.com/scheduled,
 * and counts posts that:
 *   (a) contain at least one #hashtag in the caption  → real content post (not SFS)
 *   (b) are scheduled within the next 48 h             → the 2-day window (4/day × 2 = 8 target)
 *
 * Results are upserted into `schedule_snapshots` (one row per model). The UI reads
 * from there and shows three severity bands:
 *   🔴 <4 — critical (less than 1 day's worth)
 *   🟠 4–7 — low (1 day but not 2)
 *   🟢 ≥8  — good
 *
 * Sessions are cached in R2 at sessions/fansly-sched-<handle>.json to avoid
 * full re-login on every sweep. Credentials come from the CRM `models` table
 * (intake_data.fansly_email / fansly_password / 2fa_key) — same data as
 * secrets.json, already in the shared Supabase project.
 */

import crypto from 'crypto'
import { chromium, type Browser, type Page } from 'playwright'
import { supabaseAdmin } from '../lib/supabase'
import { sendTelegram } from '../lib/telegram'
import { uploadToR2, r2 } from '../lib/r2'
import { GetObjectCommand } from '@aws-sdk/client-s3'

const FANSLY_URL = 'https://fansly.com'
const BUCKET = process.env.R2_BUCKET_NAME ?? 'fansly-trends'
const BATCH_SIZE = 8
const WINDOW_MS = 48 * 60 * 60 * 1000  // 48 h
const THRESHOLD = 8

// ─── TOTP (inline — same algorithm as scraper/totp.ts, no cross-module import) ──

function base32Decode(secret: string): Buffer {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const c of secret.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')) {
    const v = chars.indexOf(c)
    if (v >= 0) bits += v.toString(2).padStart(5, '0')
  }
  const bytes = bits.match(/.{1,8}/g)!.filter(b => b.length === 8).map(b => parseInt(b, 2))
  return Buffer.from(bytes)
}

function generateTOTP(secret: string): string {
  const key = base32Decode(secret)
  const counter = Math.floor(Date.now() / 1000 / 30)
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const hmac = crypto.createHmac('sha1', key)
  hmac.update(buf)
  const hash = hmac.digest()
  const offset = hash[hash.length - 1] & 0x0f
  const code =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    hash[offset + 3]
  return (code % 1_000_000).toString().padStart(6, '0')
}

function parseTotpSecret(raw: string): string {
  if (!raw) return ''
  const s = raw.trim()
  if (s.startsWith('otpauth://')) {
    try { return new URL(s).searchParams.get('secret') ?? '' } catch { return '' }
  }
  return s.replace(/\s/g, '')
}

function secondsUntilNextWindow(): number {
  return 30 - (Math.floor(Date.now() / 1000) % 30)
}

// ─── Credentials ──────────────────────────────────────────────────────────────

interface FanslyModelCreds {
  email: string
  password: string
  totpSecret: string
}

export async function resolveFanslyModelCreds(handle: string): Promise<FanslyModelCreds> {
  const { data, error } = await supabaseAdmin
    .from('models')
    .select('intake_data')
    .ilike('username', handle)
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`CRM lookup failed for @${handle}: ${error.message}`)
  const intake = (data as { intake_data?: Record<string, unknown> } | null)?.intake_data ?? {}
  const email = intake['fansly_email'] as string | undefined
  const password = intake['fansly_password'] as string | undefined
  const rawTotp = (intake['2fa_key'] ?? intake['twofa_key'] ?? intake['totp'] ?? '') as string
  if (!email || !password) throw new Error(`Missing Fansly credentials in CRM for @${handle}`)
  return { email, password, totpSecret: parseTotpSecret(rawTotp) }
}

// ─── R2 session cache ─────────────────────────────────────────────────────────

function schedSessionKey(handle: string): string {
  return `sessions/fansly-sched-${handle.toLowerCase()}.json`
}

async function loadStorageStateFromR2(key: string): Promise<object | null> {
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    const chunks: Uint8Array[] = []
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk)
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    return null
  }
}

async function saveStorageStateToR2(page: Page, key: string): Promise<void> {
  try {
    const state = await page.context().storageState()
    await uploadToR2(key, Buffer.from(JSON.stringify(state)), 'application/json')
  } catch (e) {
    console.warn(`  ⚠ fansly-sched: saveSession failed: ${(e as Error).message}`)
  }
}

// ─── Fansly login ─────────────────────────────────────────────────────────────

async function loginFansly(page: Page, creds: FanslyModelCreds): Promise<void> {
  await page.goto(`${FANSLY_URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2_000)

  // Dismiss cookie / age-gate popups
  for (const text of ['Enter', 'Accept All', 'Maybe Later']) {
    await page.evaluate((t: string) => {
      const el = [...document.querySelectorAll('button,[role="button"]')].find(
        e => (e as HTMLElement).textContent?.trim() === t,
      ) as HTMLElement | undefined
      if (el) el.click()
    }, text).catch(() => {})
    await page.waitForTimeout(200)
  }

  // Click the Login button in the top nav if present
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button,a,[role="button"]')].find(
      e => (e as HTMLElement).innerText?.trim() === 'Login',
    ) as HTMLElement | undefined
    if (b) b.click()
  }).catch(() => {})
  await page.waitForTimeout(1_000)

  await page.waitForSelector('#fansly_login', { timeout: 15_000 })
  await page.locator('#fansly_login').fill(creds.email)
  await page.waitForTimeout(300)
  await page.locator('#fansly_password').fill(creds.password)
  await page.waitForTimeout(400)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(4_000)

  // Handle 2FA if present
  const twofa = await page.$('input[maxlength="6"], input[placeholder*="code" i], input[placeholder*="2fa" i]')
  if (twofa) {
    if (creds.totpSecret) {
      const remaining = secondsUntilNextWindow()
      if (remaining < 5) await page.waitForTimeout((remaining + 2) * 1_000)
      await twofa.fill(generateTOTP(creds.totpSecret))
      await page.keyboard.press('Enter')
      await page.waitForTimeout(5_000)
    } else {
      throw new Error('2FA required but no TOTP secret in CRM')
    }
  }

  const session = await page.evaluate(
    () => localStorage.getItem('session_active_session'),
  ).catch(() => null) as string | null
  if (!session || session === 'null') {
    throw new Error(`Fansly login failed for ${creds.email} — no session token after login`)
  }
}

// ─── Per-model session helper ─────────────────────────────────────────────────

async function withFanslyScheduledPage<T>(
  handle: string,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const sessionKey = schedSessionKey(handle)
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--no-zygote', '--disable-gpu'],
  })
  try {
    const savedState = await loadStorageStateFromR2(sessionKey)
    const context = savedState
      ? await browser.newContext({
          timezoneId: 'UTC',
          storageState: savedState as import('playwright').BrowserContextOptions['storageState'],
        })
      : await browser.newContext({ timezoneId: 'UTC' })

    const page = await context.newPage()
    page.setDefaultTimeout(30_000)

    // Check if session is still valid (a logged-in user has session_active_session in localStorage)
    if (savedState) {
      await page.goto(`${FANSLY_URL}/scheduled`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2_000)
      const hasSession = await page.evaluate(
        () => !!localStorage.getItem('session_active_session'),
      ).catch(() => false)
      if (!hasSession) {
        // Session expired — do a fresh login
        console.log(`  ℹ @${handle}: session expired, re-logging in`)
        const creds = await resolveFanslyModelCreds(handle)
        await loginFansly(page, creds)
        await saveStorageStateToR2(page, sessionKey)
        await page.goto(`${FANSLY_URL}/scheduled`, { waitUntil: 'domcontentloaded' })
        await page.waitForTimeout(2_000)
      }
    } else {
      // No saved session — fresh login then navigate
      console.log(`  ℹ @${handle}: no saved session, logging in fresh`)
      const creds = await resolveFanslyModelCreds(handle)
      await loginFansly(page, creds)
      await saveStorageStateToR2(page, sessionKey)
      await page.goto(`${FANSLY_URL}/scheduled`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2_000)
    }

    return await fn(page)
  } finally {
    await browser.close().catch(() => {})
  }
}

// ─── Scheduled page scraper ───────────────────────────────────────────────────

export interface ScheduledPost {
  scheduledAt: string  // ISO 8601 UTC
  caption: string
}

export interface ModelScheduleResult {
  modelId: string
  handle: string
  count: number
  posts: ScheduledPost[]
  error?: string
}

export async function checkModelSchedule(
  handle: string,
  modelId: string,
): Promise<ModelScheduleResult> {
  const deadline = new Date(Date.now() + WINDOW_MS)
  try {
    return await withFanslyScheduledPage(handle, async page => {
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})

      // Lazy-scroll to load all cards (max 30 iterations; stop when DOM stops growing)
      let prevLen = -1
      for (let s = 0; s < 30; s++) {
        const len = await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight)
          document.querySelectorAll('main, [class*="overflow-y"], [class*="scroll"]').forEach(
            el => el.scrollTo(0, (el as HTMLElement).scrollHeight),
          )
          return document.body.innerHTML.length
        })
        if (len === prevLen) break
        prevLen = len
        await page.waitForTimeout(600)
      }

      // Extract all scheduled post cards.
      // Fansly renders each scheduled post as a card with:
      //   • a datetime line: "Will send on {Weekday}, {Month} {D}, {Year} at {H}:{MM} {AM/PM}"
      //   • a text body with the caption
      // We read the full card text and parse both fields from it.
      const datePattern = /Will send on \w+, \w+ \d{1,2}, \d{4} at \d{1,2}:\d{2} (?:AM|PM)/g

      const rawCards = await page.evaluate(() => {
        // Each scheduled post lives inside a container that has the "Will send on …" label.
        const results: Array<{ datetime: string; text: string }> = []
        const walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */)
        let node: Node | null
        const seen = new Set<string>()

        while ((node = walker.nextNode())) {
          const t = (node as Text).textContent ?? ''
          if (!t.includes('Will send on ')) continue

          // Walk up to find the card container
          let el: Element | null = (node as Text).parentElement
          for (let d = 0; d < 12 && el; d++, el = el.parentElement) {
            const text = (el as HTMLElement).innerText ?? ''
            if (text.includes('Will send on ') && text.length > 50 && !seen.has(text.slice(0, 80))) {
              seen.add(text.slice(0, 80))
              const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
              const dtLine = lines.find(l => l.startsWith('Will send on '))
              if (dtLine) {
                results.push({ datetime: dtLine, text })
              }
              break
            }
          }
        }
        return results
      })

      const posts: ScheduledPost[] = []
      for (const card of rawCards) {
        // Parse the datetime string: "Will send on Friday, Jul 11, 2026 at 12:00 AM"
        const dtStr = card.datetime.replace('Will send on ', '').replace(' at ', ' ')
        const parsed = new Date(dtStr)
        if (isNaN(parsed.getTime())) continue

        // Skip posts beyond the 48h window
        if (parsed > deadline) continue

        // Extract caption: everything after the datetime line, excluding UI chrome (Edit Post, Hide Attachments etc.)
        const lines = card.text.split('\n').map(l => l.trim()).filter(Boolean)
        const dtIdx = lines.findIndex(l => l.startsWith('Will send on '))
        const captionLines = dtIdx >= 0 ? lines.slice(dtIdx + 1) : lines
        const uiWords = new Set(['Edit Post', 'Hide Attachments', 'Show Attachments'])
        const caption = captionLines.filter(l => !uiWords.has(l)).join(' ').trim()

        // Must contain at least one hashtag — SFS posts have only @mentions
        if (!/#\w+/.test(caption)) continue

        posts.push({ scheduledAt: parsed.toISOString(), caption })
      }

      console.log(`[schedule] ✓ @${handle}: ${posts.length} hashtagged posts in 48h`)
      return { modelId, handle, count: posts.length, posts }
    })
  } catch (e) {
    const msg = (e as Error).message.slice(0, 120)
    console.error(`[schedule] ✗ @${handle}: ${msg}`)
    return { modelId, handle, count: 0, posts: [], error: msg }
  }
}

// ─── Fleet sweep ─────────────────────────────────────────────────────────────

export async function runScheduleCheck(onlyHandle?: string): Promise<string> {
  const { data: models } = await supabaseAdmin
    .from('trends_models')
    .select('id, fansly_username, model_number')
    .order('model_number', { ascending: true })
  if (!models?.length) return 'schedule-check: no models'

  const targets = (
    models as Array<{ id: string; fansly_username: string; model_number: number | null }>
  ).filter(
    m => !onlyHandle || m.fansly_username.toLowerCase() === onlyHandle.toLowerCase(),
  )

  const results: ModelScheduleResult[] = []

  // Process in batches of BATCH_SIZE to limit concurrent Playwright instances
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE)
    const batchResults = await Promise.allSettled(
      batch.map(m => checkModelSchedule(m.fansly_username, m.id)),
    )
    for (const r of batchResults) {
      if (r.status === 'fulfilled') results.push(r.value)
    }
  }

  // Upsert all results to schedule_snapshots
  for (const r of results) {
    await supabaseAdmin.from('schedule_snapshots').upsert({
      model_id: r.modelId,
      scraped_at: new Date().toISOString(),
      scheduled_count: r.count,
      posts: r.posts,
      error: r.error ?? null,
    }, { onConflict: 'model_id' })
  }

  // Build Telegram alert for models below threshold (grouped by severity)
  const critical = results.filter(r => !r.error && r.count < 4)
  const low = results.filter(r => !r.error && r.count >= 4 && r.count < THRESHOLD)
  const errors = results.filter(r => !!r.error)

  if (critical.length > 0 || low.length > 0) {
    const lines: string[] = [`📅 <b>Scheduled posts check (${targets.length} models)</b>`]
    if (critical.length > 0) {
      lines.push(`\n🔴 <b>Critical (&lt;4):</b> ` + critical.map(r => `@${r.handle} (${r.count})`).join(', '))
    }
    if (low.length > 0) {
      lines.push(`🟠 <b>Low (4–7):</b> ` + low.map(r => `@${r.handle} (${r.count})`).join(', '))
    }
    if (errors.length > 0) {
      lines.push(`⚠️ ${errors.length} model(s) failed to scrape`)
    }
    await sendTelegram(lines.join('\n')).catch(() => {})
  }

  const ok = results.filter(r => !r.error && r.count >= THRESHOLD).length
  const summary = `schedule-check done: ${ok}/${targets.length} models ≥${THRESHOLD} · ` +
    `critical=${critical.length} · low=${low.length} · errors=${errors.length}`
  console.log(`[schedule] ${summary}`)
  return summary
}
