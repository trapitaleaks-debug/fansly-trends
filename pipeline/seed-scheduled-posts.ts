/**
 * One-time script: scrape FanCore "Already Scheduled → Scheduled" for all models
 * and seed the scheduled_posts table in Supabase.
 *
 * Run: ts-node --project pipeline/tsconfig.json pipeline/seed-scheduled-posts.ts
 */

import * as dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(__dirname, '../.env.local') })

import { chromium, type Browser, type Page } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { r2 } from '../lib/r2'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { sendTelegram } from '../lib/telegram'

// Authoritative active-model check via FanCore's /api/me — the sidebar text-node heuristics
// can silently point at the wrong model, and wrong-model reads used to corrupt scheduled_posts
// (→ false phantom re-queues → duplicate posts). null = API unavailable (fall back carefully).
async function getActiveModel(page: Page): Promise<string | null> {
  return page
    .evaluate(async () => {
      try {
        const r = await fetch('/api/me', { credentials: 'include' })
        if (!r.ok) return null
        const j = await r.json()
        return j?.username ?? null
      } catch {
        return null
      }
    })
    .then(u => (u ? String(u).replace(/^@/, '').toLowerCase() : null))
}

const FANCORE_URL = 'https://fancore-production.up.railway.app'
const SESSION_R2_KEY = 'sessions/fancore.json'
const BUCKET = process.env.R2_BUCKET_NAME ?? 'fansly-trends'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
)

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

async function run() {
  const singleModel = process.argv[2] ?? null // optional: only process this handle

  const { data: trendModels, error: tmErr } = await supabase
    .from('trends_models').select('id, fansly_username').order('fansly_username')
  if (tmErr || !trendModels) { console.error('trends_models:', tmErr?.message); process.exit(1) }
  const handleToTrendsId = new Map<string, string>((trendModels as any[]).map(m => [m.fansly_username, m.id]))

  const { data: crmModels, error: cmErr } = await supabase.from('models').select('id, username')
  if (cmErr || !crmModels) { console.error('models:', cmErr?.message); process.exit(1) }
  const usernameToId = new Map<string, number>((crmModels as any[]).map(m => [m.username, m.id]))

  const savedState = await loadStorageState()
  const browser: Browser = await chromium.launch({ headless: true })
  const context = savedState
    ? await browser.newContext({ timezoneId: 'UTC', storageState: savedState as any })
    : await browser.newContext({ timezoneId: 'UTC' })
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)

  // Navigate directly to the "Already Scheduled" page
  await page.goto(`${FANCORE_URL}/bulk-posts/already`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  const hasLoginForm = await page.locator('input[name="password"]').isVisible({ timeout: 3_000 }).catch(() => false)
  if (page.url().includes('/signin') || hasLoginForm) {
    // Re-login using credentials from env
    const email = process.env.FANCORE_EMAIL!
    const password = process.env.FANCORE_PASSWORD!
    await page.fill('input[name="email"]', email)
    await page.fill('input[name="password"]', password)
    await page.locator('button[type="submit"]').first().click()
    await page.waitForURL(url => !String(url).includes('/signin'), { timeout: 20_000 })
    await page.goto(`${FANCORE_URL}/bulk-posts/already`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  }
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  console.log('✓ On /bulk-posts/already\n')

  const allHandles = (trendModels as any[]).map(m => m.fansly_username)
  const handles = singleModel ? allHandles.filter(h => h === singleModel) : allHandles
  let totalInserted = 0

  const now = new Date()
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

  // FanCore auto-selects the first sidebar model on page load. Clicking an already-selected
  // model deselects it (FanCore toggle behaviour), giving Scheduled(0). Track the currently
  // selected handle via /api/me (authoritative) and skip the click when already on the model.
  let currentlySelected: string | null = await getActiveModel(page)
  console.log(`  auto-selected on load: @${currentlySelected ?? 'none'}`)

  const skippedHandles: string[] = []
  const markSkipped = (handle: string, reason: string) => {
    skippedHandles.push(handle)
    console.warn(`  ⚠ @${handle} skipped: ${reason} — NOT touching its rows`)
  }
  // Stamp scrape freshness — reconcile_phantom_posts only trusts models with a recent stamp,
  // so a skipped/failed model can never trigger false phantom re-queues (duplicate posts).
  const stampFresh = async (handle: string) => {
    const trendsId = handleToTrendsId.get(handle)
    if (!trendsId) return
    await supabase.from('trends_models')
      .update({ last_seed_scrape_at: new Date().toISOString() })
      .eq('id', trendsId)
  }

  for (const handle of handles) {
    const modelId = usernameToId.get(handle)
    if (!modelId) { markSkipped(handle, 'no CRM match'); continue }
    console.log(`→ @${handle} (id=${modelId})`)

    if (currentlySelected !== handle.toLowerCase()) {
      // Click the model in the sidebar — find by @username text. CASE-INSENSITIVE: trends_models
      // stores lowercase handles but FanCore displays mixed case (@CardioLina) — exact:true
      // silently missed every new model (#29–34), which is why they "weren't in FanCore".
      const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const modelEntry = page.getByText(new RegExp(`^@${escaped}$`, 'i')).first()
      let visible = await modelEntry.isVisible({ timeout: 8_000 }).catch(() => false)
      if (!visible) {
        // 34 models don't all render — scroll the sidebar before declaring absence
        for (let i = 0; i < 10 && !visible; i++) {
          await page.evaluate(() =>
            document.querySelectorAll('aside, [class*="sidebar"], [class*="overflow"]').forEach(el => el.scrollBy(0, 400))
          )
          await page.waitForTimeout(400)
          visible = await modelEntry.isVisible().catch(() => false)
        }
      }
      if (!visible) {
        // Sidebar may be stale — re-navigate and retry once
        await page.goto(`${FANCORE_URL}/bulk-posts/already`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await page.waitForTimeout(2000)
        const visible2 = await modelEntry.isVisible({ timeout: 5_000 }).catch(() => false)
        if (!visible2) { markSkipped(handle, 'not in sidebar'); continue }
        // After re-navigate, auto-selected model changed — update tracking
        currentlySelected = null
      }
      await modelEntry.click()
      await page.waitForTimeout(2500) // FanCore SPA: fixed wait for XHR + React re-render
      // Verify the click actually switched context — wrong-model reads corrupt scheduled_posts.
      const active = await getActiveModel(page)
      if (active && active !== handle.toLowerCase()) { markSkipped(handle, `wrong model active (@${active})`); continue }
      currentlySelected = active ?? handle.toLowerCase()
    }

    // Click "Scheduled (N)" sub-tab
    const scheduledBtn = page.locator('button').filter({ hasText: /^Scheduled \(\d+\)$/ }).first()
    const scheduledText = await scheduledBtn.textContent({ timeout: 6_000 }).catch(() => '')
    if (!scheduledText || !/\(\d+\)/.test(scheduledText)) {
      // Button never rendered — page state unknown. The old code parsed '' as Scheduled(0) and
      // MASS-DELETED the model's future rows → reconcile re-queued landed posts → duplicates.
      markSkipped(handle, 'Scheduled tab did not render')
      continue
    }
    const totalScheduled = parseInt(scheduledText.match(/\((\d+)\)/)?.[1] ?? '0', 10)
    if (totalScheduled === 0) {
      // FanCore verifiably reports 0 scheduled — clear any stale future rows
      await supabase
        .from('scheduled_posts')
        .delete()
        .eq('model_id', modelId)
        .gte('scheduled_for', todayUTC.toISOString())
      console.log(`  ℹ Scheduled(0) — cleared future rows`)
      await stampFresh(handle)
      continue
    }
    await scheduledBtn.click()
    await page.waitForTimeout(1000)

    // Scroll the list until all posts are loaded — FanCore lazy-loads cards on scroll
    const scrollable = page.locator('main, [class*="overflow-y"], [class*="scroll"]').first()
    let prevCount = 0
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await scrollable.evaluate(el => el.scrollTo(0, el.scrollHeight)).catch(() => {})
      await page.waitForTimeout(600)
      const cur = await page.evaluate(() =>
        (document.body.innerHTML.match(/\d{1,2}\/\d{1,2}\/\d{4},\s*\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)/g) ?? []).length
      )
      if (cur >= totalScheduled || cur === prevCount) break
      prevCount = cur
    }

    // Count occurrences of each timestamp via text nodes — FanCore schedules multiple
    // videos at the exact same second (all 4 slots share one timestamp). innerHTML Set
    // would collapse them to 1; walking text nodes gives us the actual count per slot.
    const isoCountMap: Record<string, number> = await page.evaluate(() => {
      const datePattern = /\d{1,2}\/\d{1,2}\/\d{4},\s*\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)/
      const walker = document.createTreeWalker(document.body, 4 /* NodeFilter.SHOW_TEXT */)
      const counts: Record<string, number> = {}
      let node: Node | null
      while ((node = walker.nextNode())) {
        const text = (node as Text).textContent?.trim() ?? ''
        const m = text.match(datePattern)
        if (m) {
          try {
            const d = new Date(m[0])
            if (!isNaN(d.getTime())) {
              const iso = d.toISOString()
              counts[iso] = (counts[iso] ?? 0) + 1
            }
          } catch { /* skip */ }
        }
      }
      return counts
    })

    const todayOrFutureEntries = Object.entries(isoCountMap)
      .filter(([iso]) => new Date(iso) >= todayUTC)

    if (todayOrFutureEntries.length === 0) {
      console.log(`  ℹ no posts today or future`)
      continue
    }

    const totalPosts = todayOrFutureEntries.reduce((s, [, c]) => s + c, 0)
    todayOrFutureEntries.sort(([a], [b]) => a.localeCompare(b))
    console.log(`  found ${totalPosts} posts across ${todayOrFutureEntries.length} slots (today+future):`)
    todayOrFutureEntries.forEach(([d, c]) => console.log(`    ${d} x${c}`))

    // Delete ALL rows for this model (today+future) before re-inserting from FanCore.
    // Scraper is source of truth — pipeline rows for past slots are kept, future ones replaced.
    await supabase
      .from('scheduled_posts')
      .delete()
      .eq('model_id', modelId)
      .gte('scheduled_for', todayUTC.toISOString())

    const rows = todayOrFutureEntries.map(([d, c]) => ({
      model_id: modelId,
      scheduled_for: d,
      post_count: c,
      platform: 'fancore',
      source: 'backfill',
      status: 'scheduled',
    }))

    const { error } = await supabase
      .from('scheduled_posts')
      .insert(rows)

    if (error) {
      console.error(`  ✗ upsert: ${error.message}`)
      markSkipped(handle, `insert failed: ${error.message}`)
    } else {
      console.log(`  ✓ upserted ${rows.length} rows`)
      totalInserted += rows.length
      await stampFresh(handle)
    }
  }

  await browser.close()
  const okCount = handles.length - skippedHandles.length
  console.log(`\n✅ ${totalInserted} rows · scraped OK: ${okCount}/${handles.length}` +
    (skippedHandles.length ? ` · skipped: ${skippedHandles.join(', ')}` : ''))
  if (skippedHandles.length > 5) {
    await sendTelegram(
      `⚠️ <b>FanslyTrends</b> seed scrape: ${skippedHandles.length}/${handles.length} models skipped ` +
      `(${skippedHandles.slice(0, 10).join(', ')}${skippedHandles.length > 10 ? '…' : ''}) — their reconcile is paused until a clean scrape`
    ).catch(() => {})
  }

  const { count } = await supabase
    .from('scheduled_posts').select('*', { count: 'exact', head: true })
  console.log(`scheduled_posts total: ${count}`)
}

run().catch(err => { console.error('Fatal:', err); process.exit(1) })
