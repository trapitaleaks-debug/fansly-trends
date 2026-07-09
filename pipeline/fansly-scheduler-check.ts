/**
 * On-demand Fansly native scheduled-posts monitor (Wave C+).
 *
 * Fetches each model's scheduled posts from the Fansly API (apiv3 /post/scheduled)
 * and counts posts that:
 *   (a) contain at least one #hashtag in the caption  → real content post (not SFS)
 *   (b) are scheduled within the next 48 h             → the 2-day window (4/day × 2 = 8 target)
 *
 * NO browser runs here. Fansly blocks headless-Chrome login on datacenter IPs, so
 * per-model API header sets (authorization + fansly-client-* anti-bot headers) are
 * minted LOCALLY on the Mac with scripts/mint-sched-headers.mjs and uploaded to R2 at
 * sessions/fansly-sched-headers-<handle>.json. This module replays them with a
 * refreshed fansly-client-ts — the same proven pattern as scraper/fansly.ts scrapeFYP.
 *
 * When a header set dies (Fansly session invalidated), the model's snapshot gets a
 * "session expired — re-run mint" error and the Telegram digest carries a 🔑 line with
 * the exact re-mint command.
 *
 * Results are upserted into `schedule_snapshots` (one row per model). The UI reads
 * from there and shows three severity bands:
 *   🔴 <4 — critical (less than 1 day's worth)
 *   🟠 4–7 — low (1 day but not 2)
 *   🟢 ≥8  — good
 */

import { supabaseAdmin } from '../lib/supabase'
import { sendTelegram } from '../lib/telegram'
import { r2 } from '../lib/r2'
import { GetObjectCommand } from '@aws-sdk/client-s3'

const SCHEDULED_URL = 'https://apiv3.fansly.com/api/v1/post/scheduled?ngsw-bypass=true'
const BUCKET = process.env.R2_BUCKET_NAME ?? 'fansly-trends'
// Strictly sequential with a gap — 8 concurrent fetches tripped Fansly's per-IP rate
// limit (HTTP 429 on 30/32 models, 09.07). One call per model ≈ 40s for the fleet.
const MODEL_DELAY_MS = 800
const RATE_LIMIT_RETRIES = [10_000, 20_000, 40_000]
const WINDOW_MS = 48 * 60 * 60 * 1000  // 48 h
const THRESHOLD = 8

// ─── Minted header sets (R2) ──────────────────────────────────────────────────

interface SchedHeaderSet {
  handle: string
  accountId: string | null
  capturedAt: string
  endpoint: string
  headers: Record<string, string>
}

function schedHeadersKey(handle: string): string {
  return `sessions/fansly-sched-headers-${handle.toLowerCase()}.json`
}

async function loadSchedHeaders(handle: string): Promise<SchedHeaderSet | null> {
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: schedHeadersKey(handle) }))
    const chunks: Uint8Array[] = []
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk)
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    return null
  }
}

// Same 13-key whitelist as scraper/fansly.ts buildFanslyHeaders. fansly-client-ts is
// refreshed per request — the server validates it, but accepts it paired with the
// originally captured fansly-client-check (proven by fix-kendi-desktop + scrapeFYP).
function freshHeaders(h: Record<string, string>): Record<string, string> {
  return {
    'authorization': h['authorization'] ?? '',
    'fansly-client-id': h['fansly-client-id'] ?? '',
    'fansly-client-ts': Date.now().toString(),
    'fansly-client-check': h['fansly-client-check'] ?? '',
    'fansly-session-id': h['fansly-session-id'] ?? '',
    'accept': 'application/json, text/plain, */*',
    'origin': 'https://fansly.com',
    'referer': 'https://fansly.com/',
    'user-agent': h['user-agent'] ?? 'Mozilla/5.0',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'cookie': h['cookie'] ?? '',
  }
}

class SessionExpiredError extends Error {}

// ─── Scheduled-posts fetch ────────────────────────────────────────────────────

export interface ScheduledPost {
  scheduledAt: string  // ISO 8601 UTC
  caption: string
}

// Response shape (discovered 09.07.2026 by sniffing fansly.com/scheduled):
// { success: true, response: { scheduledPosts: [{ postId, accountId, status,
//   postTemplate: "<JSON string with .content caption>", scheduledFor: <epoch MS> }],
//   aggregationData: {...} } }
// One request returns the FULL queue (78 posts / 19 days verified) — no pagination.
async function fetchScheduledPosts(hs: SchedHeaderSet): Promise<ScheduledPost[]> {
  let res = await fetch(hs.endpoint || SCHEDULED_URL, { headers: freshHeaders(hs.headers) })
  for (const backoff of RATE_LIMIT_RETRIES) {
    if (res.status !== 429) break
    await new Promise(resolve => setTimeout(resolve, backoff))
    res = await fetch(hs.endpoint || SCHEDULED_URL, { headers: freshHeaders(hs.headers) })
  }
  if (res.status === 401 || res.status === 403) {
    throw new SessionExpiredError(`HTTP ${res.status} from /post/scheduled`)
  }
  if (res.status !== 200) throw new Error(`HTTP ${res.status} from /post/scheduled`)
  const json = await res.json().catch(() => null) as {
    success?: boolean
    response?: { scheduledPosts?: Array<{ postTemplate?: string; scheduledFor?: number }> }
  } | null
  // Missing envelope = silently unauthenticated (Fansly returns success:true + empty
  // structures for bad auth instead of 401 — same trap as scraper/fansly.ts scrapeFYP).
  // A genuinely empty schedule still has scheduledPosts: [].
  if (json?.success !== true || !Array.isArray(json?.response?.scheduledPosts)) {
    throw new SessionExpiredError('invalid response envelope — auth headers no longer accepted')
  }
  const posts: ScheduledPost[] = []
  for (const p of json.response.scheduledPosts) {
    if (!p.scheduledFor) continue
    let caption = ''
    try { caption = (JSON.parse(p.postTemplate ?? '{}')?.content ?? '') as string } catch {}
    posts.push({ scheduledAt: new Date(p.scheduledFor).toISOString(), caption })
  }
  return posts
}

// ─── Per-model check ─────────────────────────────────────────────────────────

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
  try {
    const hs = await loadSchedHeaders(handle)
    if (!hs) {
      throw new SessionExpiredError('no minted headers in R2 — run mint')
    }
    const all = await fetchScheduledPosts(hs)
    const now = Date.now()
    const deadline = now + WINDOW_MS
    const posts = all.filter(p => {
      const t = Date.parse(p.scheduledAt)
      // pending posts inside the 48h window, with at least one #hashtag (SFS posts have only @mentions)
      return t > now && t <= deadline && /#\w+/.test(p.caption)
    })
    console.log(`[schedule] ✓ @${handle}: ${posts.length} hashtagged posts in 48h (${all.length} total scheduled)`)
    return { modelId, handle, count: posts.length, posts }
  } catch (e) {
    const msg = e instanceof SessionExpiredError && !e.message.startsWith('no minted headers')
      ? `session expired — re-run mint (${e.message})`.slice(0, 120)
      : (e as Error).message.slice(0, 120)
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

  for (const m of targets) {
    results.push(await checkModelSchedule(m.fansly_username, m.id))
    await new Promise(resolve => setTimeout(resolve, MODEL_DELAY_MS))
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
  const remint = errors.filter(r =>
    r.error!.startsWith('session expired') || r.error!.startsWith('no minted headers'))

  if (critical.length > 0 || low.length > 0 || remint.length > 0) {
    const lines: string[] = [`📅 <b>Scheduled posts check (${targets.length} models)</b>`]
    if (critical.length > 0) {
      lines.push(`\n🔴 <b>Critical (&lt;4):</b> ` + critical.map(r => `@${r.handle} (${r.count})`).join(', '))
    }
    if (low.length > 0) {
      lines.push(`🟠 <b>Low (4–7):</b> ` + low.map(r => `@${r.handle} (${r.count})`).join(', '))
    }
    if (remint.length > 0) {
      lines.push(
        `🔑 <b>Re-mint needed:</b> ` + remint.map(r => `@${r.handle}`).join(', ') +
        `\n<code>cd fansly-trends && node scripts/mint-sched-headers.mjs --only &lt;handle&gt;</code>`,
      )
    }
    if (errors.length > remint.length) {
      lines.push(`⚠️ ${errors.length - remint.length} model(s) failed with other errors`)
    }
    await sendTelegram(lines.join('\n')).catch(() => {})
  }

  const ok = results.filter(r => !r.error && r.count >= THRESHOLD).length
  const summary = `schedule-check done: ${ok}/${targets.length} models ≥${THRESHOLD} · ` +
    `critical=${critical.length} · low=${low.length} · errors=${errors.length}`
  console.log(`[schedule] ${summary}`)
  return summary
}
