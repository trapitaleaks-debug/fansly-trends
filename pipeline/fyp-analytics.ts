/**
 * FYP analytics feed (Wave C). FanCore exposes a clean JSON API per model:
 *   GET /api/fyp/media?limit=N → [{ media_offer_id, views (FYP), direct_views,
 *       interaction_time_ms, duration_sec, is_video, thumbnail_url, ... }]
 * (range params are ignored server-side — the numbers are synced lifetime totals; snapshots
 * over time let us derive windows later). No analytics UI on our side (user decision) —
 * this exists to feed the weekly repost picker and, later, template performance stats.
 */

import { chromium, type Browser, type Page } from 'playwright'
import { supabaseAdmin } from '../lib/supabase'
import { sendTelegram } from '../lib/telegram'
import {
  resolveMemberCreds, loginFanCore, createContext, getActiveModel,
  FANCORE_URL, SESSION_R2_KEY,
} from './post-video-job'

export type FypMedia = {
  media_offer_id: string
  views: number
  direct_views: number
  interaction_time_ms: number
  duration_sec: number | null
  is_video: boolean
  thumbnail_url: string | null
}

// Open a logged-in page for the model (member account; /bulk-posts/already is a known-good
// SPA entry) and hand it to fn. Same house pattern as fancore-hygiene.withBulkPostsPage.
export async function withFanCorePage<T>(handle: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const memberCreds = await resolveMemberCreds(handle)
  const sessionKey = memberCreds ? `sessions/fancore-${handle.toLowerCase()}.json` : SESSION_R2_KEY
  const browser: Browser = await chromium.launch({ headless: true, args: ['--no-zygote', '--disable-gpu'] })
  try {
    const { context } = await createContext(browser, sessionKey)
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    await page.goto(`${FANCORE_URL}/bulk-posts/already`, { waitUntil: 'domcontentloaded' })
    const hasLoginForm = await page.locator('input[name="password"]').isVisible({ timeout: 3_000 }).catch(() => false)
    if (page.url().includes('/signin') || hasLoginForm) {
      await loginFanCore(page, memberCreds)
      await page.goto(`${FANCORE_URL}/bulk-posts/already`, { waitUntil: 'domcontentloaded' })
    }
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    const active = await getActiveModel(page)
    if (memberCreds && active !== handle.toLowerCase()) {
      throw new Error(`fyp: member active model @${active ?? 'none'} ≠ @${handle}`)
    }
    return await fn(page)
  } finally {
    await browser.close().catch(() => {})
  }
}

export async function fetchFypMedia(page: Page, limit = 100): Promise<FypMedia[]> {
  const rows = await page.evaluate(async (l: number) => {
    const r = await fetch(`/api/fyp/media?limit=${l}`, { credentials: 'include' })
    if (!r.ok) throw new Error(`fyp/media HTTP ${r.status}`)
    return r.json()
  }, limit)
  return (rows as FypMedia[]).filter(m => m.is_video && m.media_offer_id)
}

export async function scrapeFypStats(handle: string, modelNumber: number): Promise<number> {
  return withFanCorePage(handle, async page => {
    const media = await fetchFypMedia(page)
    if (media.length === 0) return 0
    const rows = media.map(m => {
      const avgWatch = m.views > 0 ? m.interaction_time_ms / m.views / 1000 : null
      return {
        model_id: modelNumber,
        media_id: m.media_offer_id,
        fyp_views: m.views ?? 0,
        direct_views: m.direct_views ?? 0,
        avg_watch_sec: avgWatch,
        engagement: avgWatch != null && m.duration_sec ? Math.min(1, avgWatch / m.duration_sec) : null,
        fancore_score: null,
        duration_sec: m.duration_sec,
      }
    })
    const { error } = await supabaseAdmin.from('fyp_media_stats').insert(rows)
    if (error) throw new Error(`fyp_media_stats insert: ${error.message}`)
    return rows.length
  })
}

export async function runFypAnalyticsSweep(onlyHandle?: string): Promise<string> {
  const { data: models } = await supabaseAdmin
    .from('trends_models')
    .select('fansly_username, model_number')
    .not('model_number', 'is', null)
    .order('model_number')
  if (!models?.length) return 'fyp sweep: no models'

  const targets = (models as Array<{ fansly_username: string; model_number: number }>)
    .filter(m => !onlyHandle || m.fansly_username.toLowerCase() === onlyHandle.toLowerCase())
  let ok = 0
  let total = 0
  const failed: string[] = []
  for (const m of targets) {
    try {
      const n = await scrapeFypStats(m.fansly_username, m.model_number)
      ok++
      total += n
      console.log(`[fyp] ✓ @${m.fansly_username}: ${n} media`)
    } catch (e) {
      failed.push(m.fansly_username)
      console.error(`[fyp] ✗ @${m.fansly_username}: ${(e as Error).message.slice(0, 100)}`)
    }
  }
  const summary = `📊 FYP analytics sweep: ${ok}/${targets.length} models, ${total} media rows` +
    (failed.length ? ` · failed: ${failed.slice(0, 8).join(', ')}` : '')
  console.log(`[fyp] ${summary}`)
  if (failed.length > 5) await sendTelegram(`⚠️ <b>FanslyTrends</b> ${summary}`).catch(() => {})
  return summary
}
