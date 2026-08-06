/**
 * reconcile-postweek.ts — one-shot repair of the verifier-poisoned week (03–06.08.2026).
 *
 * The DOM-based landing check filed ~307 healthy posts as `error`. This walks every errored job
 * since 03.08 and asks the only sources that don't lie:
 *   1. FanCore's own /api/bulk-posts rows (per model, member-scoped, field `scheduled_at`) —
 *      did FanCore accept a post at the job's exact slot minute?
 *   2. Fansly's /post/scheduled (minted header sets) — is it queued on Fansly for the future?
 *
 * Matched → status='posted' (+posted_at, diagnosis, fail count cleared).
 * Unmatched → left as error: those are the genuinely lost ones, retried only under the NEW verifier.
 * Repost jobs flipped to posted also get their repost_airings row and repost_videos gates restored
 * (reversing the 05.08 blanket release where it was wrong).
 * Duplicate hunt: repost videos with ≥2 wall airings inside the window are REPORTED, never deleted.
 *
 * Dry by default: POST /reconcile-postweek       (report only)
 *                 POST /reconcile-postweek?apply=1
 */
import { supabaseAdmin } from '../lib/supabase'
import { sendTelegram } from '../lib/telegram'
import { loadSchedHeaders, freshHeaders } from './fansly-scheduler-check'
import { withFanCorePage } from './fyp-analytics'

const SINCE = '2026-08-03T00:00:00Z'
const minuteKey = (iso: string) => new Date(iso).toISOString().slice(0, 16)

type ErrJob = {
  id: string; model_id: string; scheduled_for: string; is_repost: boolean
  error_message: string | null
  trends_models: { fansly_username: string; model_number: number } | null
}

// All slot-minutes FanCore holds for this model (bulk-posts API, member-scoped).
async function fancoreMinutes(handle: string): Promise<Map<string, string>> {
  return withFanCorePage(handle, async page => {
    const rows = await page.evaluate(async () => {
      const out: Array<{ s: string; st: string }> = []
      for (let off = 0; off < 1000; off += 100) {
        const r = await fetch(`/api/bulk-posts?limit=100&offset=${off}`, { credentials: 'include' })
        if (!r.ok) break
        const j = await r.json()
        const page = (j?.posts || j?.data || (Array.isArray(j) ? j : [])) as Array<Record<string, unknown>>
        if (!page.length) break
        for (const p of page) out.push({ s: String(p.scheduled_at ?? ''), st: String(p.status ?? '') })
        if (page.length < 100) break
      }
      return out
    })
    const m = new Map<string, string>()
    for (const r of rows) {
      if (!r.s) continue
      const d = new Date(r.s)
      if (!isNaN(d.getTime())) m.set(d.toISOString().slice(0, 16), r.st)
    }
    return m
  })
}

// Future-scheduled minutes on Fansly itself (header replay; best-effort).
async function fanslyScheduledMinutes(handle: string): Promise<Set<string>> {
  const out = new Set<string>()
  const hs = await loadSchedHeaders(handle)
  if (!hs) return out
  try {
    const res = await fetch('https://apiv3.fansly.com/api/v1/post/scheduled?ngsw-bypass=true', { headers: freshHeaders(hs.headers) })
    if (res.status !== 200) return out
    const j = await res.json().catch(() => null) as { response?: { scheduledPosts?: Array<{ scheduledFor?: number }> } } | null
    for (const p of j?.response?.scheduledPosts ?? []) {
      if (p.scheduledFor) out.add(new Date(p.scheduledFor).toISOString().slice(0, 16))
    }
  } catch { /* best-effort */ }
  return out
}

export async function reconcilePostWeek(apply: boolean): Promise<string> {
  const { data } = await supabaseAdmin.from('video_jobs')
    .select('id, model_id, scheduled_for, is_repost, error_message, trends_models(fansly_username, model_number)')
    .eq('status', 'error')
    .gte('updated_at', SINCE)
    .ilike('error_message', '%absent from Scheduled%')
  const jobs = (data ?? []) as unknown as ErrJob[]

  const byModel = new Map<string, ErrJob[]>()
  for (const j of jobs) {
    const h = j.trends_models?.fansly_username
    if (!h) continue
    ;(byModel.get(h) ?? byModel.set(h, []).get(h)!).push(j)
  }

  let fixed = 0, lost = 0, airingsRestored = 0
  const dupes: string[] = []
  const perModel: string[] = []

  for (const [handle, list] of byModel) {
    let fc: Map<string, string>
    try { fc = await fancoreMinutes(handle) } catch (e) {
      perModel.push(`@${handle}: SKIPPED — ${(e as Error).message.slice(0, 80)}`)
      continue
    }
    const fansly = await fanslyScheduledMinutes(handle)
    let mFixed = 0, mLost = 0

    for (const j of list) {
      const mk = minuteKey(j.scheduled_for)
      const st = fc.get(mk)
      const landed = (st !== undefined && !st.toUpperCase().includes('FAIL')) || fansly.has(mk)
      if (!landed) { mLost++; lost++; continue }
      mFixed++; fixed++
      if (!apply) continue

      await supabaseAdmin.from('video_jobs').update({
        status: 'posted',
        posted_at: j.scheduled_for,
        post_fail_count: 0,
        needs_review: false,
        diagnosis: 'reconciled 06.08 — verifier false negative (DOM date-format bug); confirmed via FanCore bulk-posts API',
      }).eq('id', j.id)

      // Repost bookkeeping: restore the airing my 05.08 release deleted for jobs that DID land.
      if (j.is_repost) {
        const { data: v } = await supabaseAdmin.from('repost_videos')
          .select('id, airings_total, airings_this_month, last_aired_at')
          .eq('model_number', j.trends_models!.model_number)
          .eq('best_media_offer_id',
            (await supabaseAdmin.from('video_jobs').select('source_media_id').eq('id', j.id).single()).data?.source_media_id ?? '')
          .maybeSingle()
        const vid = v as { id: string; airings_total: number; airings_this_month: number; last_aired_at: string | null } | null
        if (vid) {
          await supabaseAdmin.from('repost_airings').upsert({
            video_id: vid.id, media_offer_id: `job:${j.id}`,
            posted_at: j.scheduled_for, source: 'scheduler', job_id: j.id,
          }, { onConflict: 'media_offer_id' })
          await supabaseAdmin.from('repost_videos').update({
            airings_total: vid.airings_total + 1,
            airings_this_month: vid.airings_this_month + 1,
            last_aired_at: !vid.last_aired_at || j.scheduled_for > vid.last_aired_at ? j.scheduled_for : vid.last_aired_at,
            updated_at: new Date().toISOString(),
          }).eq('id', vid.id)
          airingsRestored++
        }
      }
    }

    perModel.push(`@${handle}: ${mFixed} fixed · ${mLost} lost`)
  }

  // Fleet-level duplicate check via SQL (video booked 2+ times since 03.08 among landed jobs)
  const { data: dupData } = await supabaseAdmin.from('repost_airings')
    .select('video_id, posted_at')
    .gte('posted_at', SINCE)
  const seen = new Map<string, number>()
  for (const a of (dupData ?? []) as Array<{ video_id: string }>) seen.set(a.video_id, (seen.get(a.video_id) ?? 0) + 1)
  for (const [vid, n] of seen) if (n > 1) dupes.push(`${vid} (${n}×)`)

  const summary = `🔧 reconcile${apply ? '' : ' (DRY)'}: ${jobs.length} poisoned jobs → ${fixed} actually landed, ${lost} genuinely lost` +
    ` · ${airingsRestored} repost airings restored · ${dupes.length} videos aired 2+ times since 03.08` +
    (dupes.length ? `\n⚠️ duplicates (report only, nothing deleted): ${dupes.slice(0, 10).join(', ')}` : '')
  console.log(`[reconcile] ${summary}`)
  for (const l of perModel) console.log(`[reconcile]   ${l}`)
  await sendTelegram(`<b>FanslyTrends</b> ${summary}`).catch(() => {})
  return summary
}
