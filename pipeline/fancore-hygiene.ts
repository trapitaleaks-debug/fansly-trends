/**
 * FanCore bulk-posting hygiene — keeps every model safely under FanCore's ~1000-record
 * bulk-post window (the silent-drop capacity bug discovered 06.07.2026).
 *
 * - readTabCounts(handle): All/Scheduled/Sent/Failed as shown in Bulk Posting → Already Scheduled.
 *   NOTE: counts are derived from a ≤1000-record API window — a model pinned at all=1000 has an
 *   unknown hidden backlog beyond it. Treat all>=WINDOW as "at capacity".
 * - cleanFailedRecords(handle): deletes FAILED records via the UI trash flow until the tab is
 *   empty. HARD RULE: only ever deletes inside the Failed filter — Scheduled/Sent records
 *   correspond to live/pending Fansly posts and deleting them could remove real posts.
 * - snapshotCapacity(): writes per-model counts to fancore_capacity (powers the watchdog cron,
 *   the pre-submit capacity gate in post-video-job, and the /models capacity badge).
 *
 * Playwright gotcha: FanCore's delete uses a NATIVE browser confirm() — a dialog handler is
 * mandatory or Playwright silently dismisses it and nothing deletes.
 */

import { chromium, type Browser, type Page } from 'playwright'
import { supabaseAdmin } from '../lib/supabase'
import { sendTelegram } from '../lib/telegram'
import {
  resolveMemberCreds, loginFanCore, createContext, getActiveModel,
  FANCORE_URL, SESSION_R2_KEY,
} from './post-video-job'

export const CAPACITY_WINDOW = 1000
export const SOFT_LIMIT = parseInt(process.env.FANCORE_CAPACITY_SOFT_LIMIT ?? '700', 10)

export type TabCounts = { all: number; scheduled: number; sent: number; failed: number }

const readCountsFromPage = (page: Page): Promise<Partial<TabCounts>> => page.evaluate(() => {
  const out: Record<string, number> = {}
  document.querySelectorAll('button').forEach(b => {
    const m = (b.textContent ?? '').trim().match(/^(All|Scheduled|Sent|Failed)\s*\((\d+)\)$/)
    if (m) out[m[1].toLowerCase()] = parseInt(m[2], 10)
  })
  return out as Partial<TabCounts>
})

// Opens /bulk-posts/already logged in as the model's member (agency fallback), verifies the
// active model, and hands the page to `fn`. Always closes the browser.
async function withBulkPostsPage<T>(handle: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const memberCreds = await resolveMemberCreds(handle)
  const sessionKey = memberCreds ? `sessions/fancore-${handle.toLowerCase()}.json` : SESSION_R2_KEY
  const browser: Browser = await chromium.launch({ headless: true, args: ['--no-zygote', '--disable-gpu'] })
  try {
    const { context } = await createContext(browser, sessionKey)
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    page.on('dialog', d => { d.accept().catch(() => {}) }) // native confirm() on delete
    await page.goto(`${FANCORE_URL}/bulk-posts/already`, { waitUntil: 'domcontentloaded' })
    const hasLoginForm = await page.locator('input[name="password"]').isVisible({ timeout: 3_000 }).catch(() => false)
    if (page.url().includes('/signin') || hasLoginForm) {
      await loginFanCore(page, memberCreds)
      await page.goto(`${FANCORE_URL}/bulk-posts/already`, { waitUntil: 'domcontentloaded' })
    }
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    const active = await getActiveModel(page)
    if (memberCreds && active !== handle.toLowerCase()) {
      throw new Error(`hygiene: member active model @${active ?? 'none'} ≠ @${handle}`)
    }
    if (!memberCreds) {
      // Agency fallback needs an explicit sidebar selection (case-insensitive)
      const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const entry = page.getByText(new RegExp(`^@${escaped}$`, 'i')).first()
      for (let i = 0; i < 10 && !(await entry.isVisible().catch(() => false)); i++) {
        await page.evaluate(() => document.querySelectorAll('aside, [class*="sidebar"], [class*="overflow"]').forEach(el => el.scrollBy(0, 400)))
        await page.waitForTimeout(400)
      }
      await entry.click({ timeout: 10_000 })
      await page.waitForTimeout(2_500)
    }
    return await fn(page)
  } finally {
    await browser.close().catch(() => {})
  }
}

export async function readTabCounts(handle: string): Promise<TabCounts> {
  return withBulkPostsPage(handle, async page => {
    const c = await readCountsFromPage(page)
    return { all: c.all ?? 0, scheduled: c.scheduled ?? 0, sent: c.sent ?? 0, failed: c.failed ?? 0 }
  })
}

export type CleanResult = { deleted: number; before: TabCounts; after: TabCounts }

export async function cleanFailedRecords(
  handle: string,
  opts: { max?: number; dry?: boolean } = {},
): Promise<CleanResult> {
  const max = opts.max ?? 5000
  return withBulkPostsPage(handle, async page => {
    const openFailedTab = async () => {
      await page.locator('button').filter({ hasText: /^Failed \(\d+\)$/ }).first().click({ timeout: 10_000 }).catch(() => {})
      await page.waitForTimeout(1_500)
    }
    const rawBefore = await readCountsFromPage(page)
    const before: TabCounts = { all: rawBefore.all ?? 0, scheduled: rawBefore.scheduled ?? 0, sent: rawBefore.sent ?? 0, failed: rawBefore.failed ?? 0 }
    if (opts.dry || before.failed === 0) {
      return { deleted: 0, before, after: before }
    }
    await openFailedTab()

    let deleted = 0
    let stuck = 0
    while (deleted < max && stuck < 5) {
      // HARD RULE: we are inside the Failed filter; the trash button is the card's only
      // .danger control. Never navigate to Scheduled/Sent while deleting.
      const trash = page.locator('button.trigger-icon-btn.danger:visible').first()
      if (!(await trash.isVisible({ timeout: 5_000 }).catch(() => false))) {
        // window exhausted in this render — reload to pull hidden records into view
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
        const counts = await readCountsFromPage(page)
        if ((counts.failed ?? 0) === 0) break
        await openFailedTab()
        if (!(await page.locator('button.trigger-icon-btn.danger:visible').first().isVisible({ timeout: 5_000 }).catch(() => false))) {
          stuck++
          continue
        }
        continue
      }
      const delResp = page.waitForResponse(r => r.request().method() === 'DELETE' && /bulk-posts/.test(r.url()), { timeout: 8_000 }).catch(() => null)
      // Click can time out when the last card is mid-removal/animating — treat as a soft miss,
      // not a crash (an uncaught throw here used to mark fully-cleaned models as FAILED).
      const clickOk = await trash.click({ timeout: 8_000 }).then(() => true).catch(() => false)
      const resp = clickOk ? await delResp : null
      if (resp && resp.status() >= 200 && resp.status() < 300) {
        deleted++
        stuck = 0
      } else {
        stuck++
        await page.keyboard.press('Escape').catch(() => {})
        await page.waitForTimeout(500)
      }
      await page.waitForTimeout(250)
      if (deleted > 0 && deleted % 200 === 0) {
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
        await openFailedTab()
      }
    }

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    const rawAfter = await readCountsFromPage(page)
    const after: TabCounts = { all: rawAfter.all ?? 0, scheduled: rawAfter.scheduled ?? 0, sent: rawAfter.sent ?? 0, failed: rawAfter.failed ?? 0 }
    return { deleted, before, after }
  })
}

// ─── Scheduled-stack dedup ────────────────────────────────────────────────────────────────────
// Capacity-era blind retries created N copies of posts stacked on the same second (e.g. ×20 at
// one slot). Keeps exactly ONE post per timestamp and deletes the surplus — pending scheduled
// posts only (nothing is on Fansly yet). User-approved 06.07.2026. Never deletes the last copy.

export type DedupResult = { slotsDeduped: number; deleted: number }

export async function dedupScheduledStacks(handle: string): Promise<DedupResult> {
  return withBulkPostsPage(handle, async page => {
    const openScheduled = async () => {
      await page.locator('button').filter({ hasText: /^Scheduled \(\d+\)$/ }).first().click({ timeout: 10_000 })
      await page.waitForTimeout(1_500)
      // lazy-load everything (scheduled counts are small post-cleanup)
      let prevLen = -1
      for (let s = 0; s < 30; s++) {
        const len = await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight)
          document.querySelectorAll('main, [class*="overflow-y"], [class*="scroll"]').forEach(el => el.scrollTo(0, el.scrollHeight))
          return document.body.innerHTML.length
        })
        if (len === prevLen) break
        prevLen = len
        await page.waitForTimeout(500)
      }
    }
    const readStacks = (): Promise<Record<string, number>> => page.evaluate(() => {
      const datePattern = /\d{1,2}\/\d{1,2}\/\d{4},\s*\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)/
      const walker = document.createTreeWalker(document.body, 4)
      const counts: Record<string, number> = {}
      let node: Node | null
      while ((node = walker.nextNode())) {
        const m = ((node as Text).textContent ?? '').match(datePattern)
        if (m) counts[m[0]] = (counts[m[0]] ?? 0) + 1
      }
      return counts
    })
    // Click the trash button INSIDE the first card showing this timestamp (native confirm()
    // is auto-accepted by the page dialog handler in withBulkPostsPage).
    const clickTrashFor = (ts: string): Promise<boolean> => page.evaluate((t: string) => {
      const walker = document.createTreeWalker(document.body, 4)
      let node: Node | null
      while ((node = walker.nextNode())) {
        if (!((node as Text).textContent ?? '').includes(t)) continue
        let el: HTMLElement | null = (node as Text).parentElement
        for (let d = 0; d < 8 && el; d++, el = el.parentElement) {
          const btn = el.querySelector<HTMLElement>('button.trigger-icon-btn.danger')
          if (btn && el.getBoundingClientRect().height < 400) { btn.click(); return true }
        }
      }
      return false
    }, ts)

    await openScheduled()
    const result: DedupResult = { slotsDeduped: 0, deleted: 0 }
    for (let round = 0; round < 60; round++) {
      const stacks = Object.entries(await readStacks()).filter(([, c]) => c > 1)
      if (stacks.length === 0) break
      const [ts, count] = stacks[0]
      // delete count-1 copies of this timestamp, re-counting each time (never the last copy)
      let remaining = count
      while (remaining > 1) {
        const delResp = page.waitForResponse(r => r.request().method() === 'DELETE' && /bulk-posts/.test(r.url()), { timeout: 8_000 }).catch(() => null)
        const clicked = await clickTrashFor(ts)
        if (!clicked) break
        const resp = await delResp
        if (!resp || resp.status() < 200 || resp.status() >= 300) break
        result.deleted++
        await page.waitForTimeout(400)
        remaining = (await readStacks())[ts] ?? 0
      }
      result.slotsDeduped++
      if (round % 10 === 9) { await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {}); await openScheduled() }
    }
    console.log(`[hygiene] @${handle} dedup: ${result.deleted} surplus copies removed across ${result.slotsDeduped} slots`)
    return result
  })
}

// ─── Capacity-clean queue ─────────────────────────────────────────────────────────────────────
// When a post fails with capacity_full, the posting worker can't run a multi-minute cleanup
// inside its own timers — it enqueues the model here instead. A single serial runner cleans the
// model's Failed records, then resurrects every capacity_full-failed job for that model so the
// post pool retries them. This is the self-healing loop for the 1000-record incident class.

const cleanQueue: Array<{ handle: string; modelId: string }> = []
const queuedHandles = new Set<string>()
let queueRunning = false

export function requestCapacityClean(handle: string, modelId: string): void {
  const key = handle.toLowerCase()
  if (queuedHandles.has(key)) return
  queuedHandles.add(key)
  cleanQueue.push({ handle, modelId })
  console.log(`[hygiene] capacity-clean queued for @${handle} (queue=${cleanQueue.length})`)
  if (!queueRunning) void drainCleanQueue()
}

async function drainCleanQueue(): Promise<void> {
  queueRunning = true
  try {
    while (cleanQueue.length > 0) {
      const { handle, modelId } = cleanQueue.shift()!
      try {
        const res = await cleanFailedRecords(handle)
        // Resurrect this model's capacity-failed jobs — rendered videos are intact in R2.
        const { data: revived } = await supabaseAdmin
          .from('video_jobs')
          .update({
            status: 'approved', post_fail_count: 0, scheduled_for: null, started_at: null,
            error_message: null, failure_kind: null, needs_review: false,
            diagnosis: 'auto-recovered after capacity clean',
          })
          .eq('model_id', modelId)
          .eq('failure_kind', 'capacity_full')
          .eq('status', 'error')
          .not('output_r2_key', 'is', null)
          .select('id')
        await sendTelegram(
          `🧹 <b>FanslyTrends</b>: @${handle} capacity clean done — deleted ${res.deleted} failed records ` +
          `(${res.before.all}→${res.after.all}), re-queued ${revived?.length ?? 0} blocked videos`
        ).catch(() => {})
      } catch (e) {
        console.error(`[hygiene] capacity-clean @${handle} failed:`, (e as Error).message)
        await sendTelegram(`🚨 <b>FanslyTrends</b>: capacity clean for @${handle} FAILED — <code>${(e as Error).message.slice(0, 200)}</code>`).catch(() => {})
      } finally {
        queuedHandles.delete(handle.toLowerCase())
      }
    }
  } finally {
    queueRunning = false
  }
}

// Latest snapshot for the pre-submit capacity gate (cheap DB read; null if never snapshotted).
export async function latestCapacity(modelNumber: number | null): Promise<TabCounts | null> {
  if (modelNumber == null) return null
  const { data } = await supabaseAdmin
    .from('fancore_capacity')
    .select('all_count, scheduled_count, sent_count, failed_count')
    .eq('model_id', modelNumber)
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  const d = data as { all_count: number; scheduled_count: number; sent_count: number; failed_count: number }
  return { all: d.all_count, scheduled: d.scheduled_count, sent: d.sent_count, failed: d.failed_count }
}

// Snapshot every model's counts into fancore_capacity; auto-clean models at/over the soft limit.
export async function runCapacityWatchdog(opts: { autoClean?: boolean } = {}): Promise<string> {
  const autoClean = opts.autoClean ?? true
  const { data: models } = await supabaseAdmin
    .from('trends_models')
    .select('id, fansly_username, model_number')
    .order('model_number')
  if (!models?.length) return 'capacity watchdog: no models'

  const lines: string[] = []
  let cleanedTotal = 0
  for (const model of models as Array<{ id: string; fansly_username: string; model_number: number | null }>) {
    const handle = model.fansly_username
    try {
      let counts = await readTabCounts(handle)
      if (autoClean && counts.all >= SOFT_LIMIT && counts.failed > 0) {
        console.log(`[hygiene] @${handle} at ${counts.all}/${CAPACITY_WINDOW} — cleaning ${counts.failed}+ failed records`)
        const res = await cleanFailedRecords(handle)
        cleanedTotal += res.deleted
        lines.push(`🧹 @${handle}: deleted ${res.deleted} failed (${res.before.all}→${res.after.all})`)
        counts = res.after
      } else if (counts.all >= SOFT_LIMIT) {
        lines.push(`⚠️ @${handle}: ${counts.all}/${CAPACITY_WINDOW} but no failed records to clean`)
      }
      await supabaseAdmin.from('fancore_capacity').insert({
        model_id: model.model_number,
        all_count: counts.all,
        scheduled_count: counts.scheduled,
        sent_count: counts.sent,
        failed_count: counts.failed,
      })
    } catch (e) {
      lines.push(`✗ @${handle}: ${(e as Error).message.slice(0, 80)}`)
    }
  }
  const summary = [`🩺 <b>FanCore capacity watchdog</b> — ${models.length} models checked` +
    (cleanedTotal ? `, ${cleanedTotal} failed records cleaned` : ', all healthy'), ...lines.slice(0, 20)].join('\n')
  console.log(`[hygiene] ${summary.replace(/<[^>]+>/g, '')}`)
  await sendTelegram(summary).catch(() => {})
  return summary
}
