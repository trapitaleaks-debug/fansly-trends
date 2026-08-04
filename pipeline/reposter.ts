/**
 * Daily repost scheduler (Wave 3 automated reposting — REWRITTEN 04.08.2026).
 *
 * Replaces the weekly top-5 picker entirely. What changed and why:
 *   - Source is the DB repost library (repost_videos, seeded from the 11-month back-catalogue
 *     scan), NOT the last-35-days fyp_media_stats window — that window couldn't see 90% of the
 *     proven videos.
 *   - Identity is the picture fingerprint. The old id-based repost_ledger couldn't tell that a
 *     re-uploaded clip was the same video (Fansly re-encodes → fresh id), which is how one clip
 *     aired 8×. The gates here read repost_videos/repost_airings, which the fortnightly scan
 *     (repost-scan.ts) keeps fingerprint-deduped.
 *   - No download, no re-encode, NO WATERMARK CROP (Vito 04.08: repost as-is) — the library file
 *     already sits in R2; the job points straight at it.
 *
 * Rules (Vito, locked 03–04.08): never-reposted first, then longest-rested · 14-day minimum gap
 * per video · max 2 airings per calendar month per video · retired videos never picked · queue
 * dry → book NOTHING (slot goes to new content; no notification) · reposts count INSIDE the
 * 10/day slots · REPOST_PER_DAY per model per day (default 2).
 *
 * Repost jobs skip rendering: inserted as status='approved' with output_r2_key preset — the
 * existing post pool + honest verification handle the rest (unchanged, proven path).
 */

import { supabaseAdmin } from '../lib/supabase'
import { sendTelegram } from '../lib/telegram'
import { getTakenSlots, FIXED_SLOTS, MIN_BUFFER_MS } from '../lib/scheduling'

const REPOST_PER_DAY = Number(process.env.REPOST_PER_DAY ?? 2)
const GAP_DAYS = 14

type Candidate = {
  id: string
  r2_key: string | null
  best_media_offer_id: string
  best_fyp_views: number
  duration_sec: number | null
  last_aired_at: string | null
  airings_total: number
  airings_this_month: number
}

// Today's free fixed slots (UTC), respecting the min buffer. Cap is law: none free → book nothing.
function freeSlotsToday(taken: Set<string>): Date[] {
  const now = new Date()
  const earliest = Date.now() + MIN_BUFFER_MS
  const out: Date[] = []
  for (const slot of FIXED_SLOTS) {
    const c = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), slot.hour, slot.minute, 0, 0))
    if (c.getTime() <= earliest) continue
    if (!taken.has(c.toISOString())) out.push(c)
  }
  return out
}

export async function runDailyRepostSchedule(opts: { dry?: boolean; onlyHandle?: string } = {}): Promise<string> {
  const dry = opts.dry ?? false

  // Monthly counter reset — idempotent: rows still carrying last month's count (updated before this
  // month began) get zeroed on the first run of the month.
  const monthStart = new Date()
  monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0)
  if (!dry) {
    await supabaseAdmin.from('repost_videos')
      .update({ airings_this_month: 0 })
      .gt('airings_this_month', 0)
      .lt('updated_at', monthStart.toISOString())
  }

  const { data: models } = await supabaseAdmin
    .from('trends_models')
    .select('id, fansly_username, model_number')
    .not('model_number', 'is', null)
    .order('model_number')
  const targets = ((models ?? []) as Array<{ id: string; fansly_username: string; model_number: number }>)
    .filter(m => !opts.onlyHandle || m.fansly_username.toLowerCase() === opts.onlyHandle.toLowerCase())

  const gapCutoff = new Date(Date.now() - GAP_DAYS * 86400_000).toISOString()
  let booked = 0
  let dryModels = 0
  const failures: string[] = []
  const lines: string[] = []

  for (const model of targets) {
    // Eligible: not retired, has a library file, rested ≥14d (or never aired), <2 this month.
    // "Never reposted first" is ordered by fewest airings_total (a video the scan saw only at its
    // original posting sorts before one aired 3×), then longest-rested.
    const { data } = await supabaseAdmin.from('repost_videos')
      .select('id, r2_key, best_media_offer_id, best_fyp_views, duration_sec, last_aired_at, airings_this_month, airings_total')
      .eq('model_number', model.model_number)
      .eq('retired', false)
      .not('r2_key', 'is', null)
      .lt('airings_this_month', 2)
      .or(`last_aired_at.is.null,last_aired_at.lt.${gapCutoff}`)
      .order('airings_total', { ascending: true })
      .order('last_aired_at', { ascending: true, nullsFirst: true })
      .limit(REPOST_PER_DAY * 2)
    const candidates = (data ?? []) as Candidate[]
    if (!candidates.length) { dryModels++; continue }   // dry queue → nothing, silently (Vito's rule)

    const taken = await getTakenSlots(model.id)
    const slots = freeSlotsToday(taken)
    if (!slots.length) continue

    let n = 0
    for (const c of candidates) {
      if (n >= REPOST_PER_DAY || n >= slots.length) break
      const slot = slots[n]
      if (dry) {
        lines.push(`DRY @${model.fansly_username}: ${c.best_media_offer_id} (${c.best_fyp_views} views, aired ${c.airings_total}×) → ${slot.toISOString()}`)
        n++; booked++
        continue
      }
      try {
        const { data: job, error } = await supabaseAdmin.from('video_jobs').insert({
          model_id: model.id,
          status: 'approved',
          output_r2_key: c.r2_key,
          scheduled_for: slot.toISOString(),
          duration_seconds: Math.round(c.duration_sec ?? 5) || 5,
          is_repost: true,
          source_media_id: c.best_media_offer_id,
          original_template: '[repost]',
          personalized_text: `♻️ repost — best ${c.best_fyp_views} FYP views, airing #${c.airings_total + 1}`,
        }).select('id').single()
        if (error) throw new Error(error.message)

        // Gate bookkeeping written IMMEDIATELY, so a same-day re-run can't double-book this video
        // even before the next scan sees the post on the wall.
        await supabaseAdmin.from('repost_videos').update({
          last_aired_at: slot.toISOString(),
          airings_this_month: c.airings_this_month + 1,
          airings_total: c.airings_total + 1,
          updated_at: new Date().toISOString(),
        }).eq('id', c.id)
        await supabaseAdmin.from('repost_airings').insert({
          video_id: c.id,
          media_offer_id: `job:${(job as { id: string }).id}`,   // placeholder; the next scan finds the real Fansly id by fingerprint
          posted_at: slot.toISOString(),
          source: 'scheduler',
          job_id: (job as { id: string }).id,
        })
        lines.push(`@${model.fansly_username}: airing #${c.airings_total + 1} of ${c.best_media_offer_id} (best ${c.best_fyp_views}) → ${slot.toISOString().slice(11, 16)} UTC`)
        taken.add(slot.toISOString())
        n++; booked++
      } catch (e) {
        failures.push(`@${model.fansly_username}: ${(e as Error).message.slice(0, 80)}`)
      }
    }
  }

  const summary = `♻️ repost scheduler${dry ? ' (DRY)' : ''}: ${booked} booked across ${targets.length} models · ${dryModels} queues dry` +
    (failures.length ? `\n⚠️ ${failures.join(' · ')}` : '')
  console.log(`[reposter] ${summary}`)
  for (const l of lines) console.log(`[reposter]   ${l}`)
  if (!dry && booked > 0) await sendTelegram(`<b>FanslyTrends</b> ${summary}`).catch(() => {})
  return summary
}
