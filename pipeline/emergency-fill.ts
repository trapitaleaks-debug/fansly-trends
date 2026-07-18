/**
 * Emergency "Fill to 8" — top every under-scheduled model up to 8 hashtagged posts in the next
 * 48h by RECYCLING ideas the model has already produced, paired with a fresh clip.
 *
 * This is deliberately different from fill-gaps: fill-gaps only inserts jobs for ideas that have
 * NO active job yet, so once the matched-idea pool is exhausted it produces nothing. When Vito is
 * out of new ideas / out of time and just needs the calendar full, this button re-renders a
 * previously-posted idea against a DIFFERENT clip from the content bank — fresh enough not to be a
 * carbon copy of a past post — and lets it render + post automatically (AUTO_APPROVE on).
 *
 * Flow (per Vito's decisions 2026-07-18):
 *   1. Live schedule sweep first (runScheduleCheck) so we fill on current Fansly counts.
 *   2. Per model: needed = 8 − live_count − in-flight_jobs  (in-flight subtracted so a repeat
 *      press never over-fills — those jobs will post into the window).
 *   3. RANDOM pick among the model's recyclable posts (status 'posted', no active job).
 *   4. Fresh clip: a bank clip NOT used for that post before; if none left, reuse one (near-dupe)
 *      so we still hit 8. (Distinct-post exhaustion is a hard DB limit — one active job per post —
 *      and is reported honestly when it happens.)
 *
 * Progress + result are written to emergency_fill_runs (single row, id='singleton') for the UI.
 */
import { supabaseAdmin } from '../lib/supabase'
import { sendTelegram } from '../lib/telegram'
import { insertVideoJobWithSlot } from '../lib/scheduling'
import { clipUsageMap, pickFromUsage } from '../lib/footage'
import { pickTemplate, resolveMemeText } from '../lib/template-select'

const TARGET = 8
// Jobs that will post into the window but aren't on Fansly yet — subtracted from the target so a
// second press doesn't stack. Also the set that makes a post ineligible to recycle (one active
// job per post is enforced by the video_jobs_one_active_per_model_post partial unique index).
const ACTIVE_STATUSES = ['pending', 'processing', 'done', 'approved', 'posting']

interface PerModel { handle: string; needed: number; filled: number; nearDupes: number; note: string | null }

async function setStatus(patch: Record<string, unknown>): Promise<void> {
  await supabaseAdmin.from('emergency_fill_runs').upsert({ id: 'singleton', ...patch }, { onConflict: 'id' })
}

export async function runEmergencyFill(): Promise<void> {
  const startedAt = new Date().toISOString()
  await setStatus({ running: true, phase: 'sweeping', started_at: startedAt, finished_at: null, totals: {}, per_model: [], error: null })

  // 1. Live sweep — refresh schedule_snapshots so we fill on the current live counts.
  try {
    const { runScheduleCheck } = await import('./fansly-scheduler-check')
    await runScheduleCheck()
  } catch (e) {
    console.error('[emergency-fill] live sweep failed, using existing snapshots:', (e as Error).message)
  }

  await setStatus({ phase: 'filling' })

  const { data: snaps } = await supabaseAdmin
    .from('schedule_snapshots')
    .select('model_id, scheduled_count, error')
  const snapByModel = new Map((snaps ?? []).map(s => [(s as { model_id: string }).model_id, s as { scheduled_count: number | null; error: string | null }]))

  const { data: models } = await supabaseAdmin
    .from('trends_models')
    .select('id, fansly_username, niches, placeholder_options, model_number')
    .not('niches', 'is', null)
    .neq('niches', '{}')
    .order('model_number')

  const perModel: PerModel[] = []
  let totalFilled = 0, totalShortfall = 0, totalNearDupes = 0, modelsBelow = 0

  for (const model of (models ?? []) as Array<{ id: string; fansly_username: string; niches: string[]; placeholder_options: string[] | null }>) {
    const snap = snapByModel.get(model.id)
    // No snapshot or the sweep errored for this model → we don't know the real count. Skip rather
    // than guess (guessing risks over-posting).
    if (!snap || snap.error) continue
    const liveCount = snap.scheduled_count ?? 0

    const { count: inflight } = await supabaseAdmin
      .from('video_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('model_id', model.id)
      .in('status', ACTIVE_STATUSES)

    const needed = Math.max(0, TARGET - liveCount - (inflight ?? 0))
    if (needed === 0) continue
    modelsBelow++

    // Content bank footage (the fresh-clip pool) — same source as fill-gaps. A model can have MORE
    // THAN ONE pipeline_models row (dup onboarding); gather footage across all of them (a single()
    // here silently dropped DumbBlondeBimbo, which had 2 rows → "no content bank").
    const { data: pms } = await supabaseAdmin
      .from('pipeline_models').select('id').ilike('handle', model.fansly_username)
    const pmIds = ((pms ?? []) as Array<{ id: string }>).map(p => p.id)
    if (pmIds.length === 0) { perModel.push({ handle: model.fansly_username, needed, filled: 0, nearDupes: 0, note: 'no content bank' }); totalShortfall += needed; continue }

    type FootageRow = { id: string; r2_key: string; label: string | null; trim_end: number | null; tags: string[] }
    const [{ data: bank }, { data: clips }] = await Promise.all([
      supabaseAdmin.from('pipeline_content_bank').select('id, r2_key, label, trim_end, tags').in('model_id', pmIds).order('created_at'),
      supabaseAdmin.from('model_clips').select('id, r2_key').eq('model_id', model.id),
    ])
    const footage = (bank ?? []) as FootageRow[]
    if (footage.length === 0) { perModel.push({ handle: model.fansly_username, needed, filled: 0, nearDupes: 0, note: 'no footage' }); totalShortfall += needed; continue }
    const r2KeyToClipId = new Map(((clips ?? []) as Array<{ id: string; r2_key: string }>).map(c => [c.r2_key, c.id]))

    // Recyclable posts = model has a 'posted' job for the post AND no active job for it (so the
    // insert won't be rejected as a duplicate). Track which clip r2_keys were already used per post.
    const { data: jobs } = await supabaseAdmin
      .from('video_jobs')
      .select('post_id, status, model_clips(r2_key)')
      .eq('model_id', model.id)
      .not('post_id', 'is', null)

    const byPost = new Map<string, { posted: boolean; active: boolean; usedKeys: Set<string> }>()
    for (const j of (jobs ?? []) as Array<{ post_id: string; status: string; model_clips: unknown }>) {
      let e = byPost.get(j.post_id)
      if (!e) { e = { posted: false, active: false, usedKeys: new Set() }; byPost.set(j.post_id, e) }
      if (j.status === 'posted') e.posted = true
      if (ACTIVE_STATUSES.includes(j.status)) e.active = true
      const mc = Array.isArray(j.model_clips) ? j.model_clips[0] : j.model_clips
      const key = (mc as { r2_key?: string } | null)?.r2_key
      if (key) e.usedKeys.add(key)
    }
    const recyclablePostIds = [...byPost.entries()].filter(([, e]) => e.posted && !e.active).map(([id]) => id)
    if (recyclablePostIds.length === 0) { perModel.push({ handle: model.fansly_username, needed, filled: 0, nearDupes: 0, note: 'no recyclable posts' }); totalShortfall += needed; continue }

    const [{ data: posts }, { data: ideaRows }] = await Promise.all([
      supabaseAdmin.from('trends_posts').select('id, text_template').in('id', recyclablePostIds),
      supabaseAdmin.from('trends_ideas').select('post_id, tags').in('post_id', recyclablePostIds),
    ])
    const textByPost = new Map(((posts ?? []) as Array<{ id: string; text_template: string | null }>).filter(p => p.text_template).map(p => [p.id, p.text_template as string]))
    const tagsByPost = new Map(((ideaRows ?? []) as Array<{ post_id: string; tags: string[] | null }>).map(r => [r.post_id, r.tags ?? []]))

    const candidates = recyclablePostIds
      .filter(id => textByPost.has(id))
      .map(id => ({ post_id: id, text: textByPost.get(id) as string, usedKeys: byPost.get(id)!.usedKeys }))

    const clipUsage = await clipUsageMap(model.id, footage)
    const options = model.placeholder_options ?? []
    const usedPostThisRun = new Set<string>()  // one active job per post → each recycled once per run
    let filled = 0, nearDupes = 0
    let guard = needed * 6

    while (filled < needed && guard-- > 0) {
      const pool = candidates.filter(c => !usedPostThisRun.has(c.post_id))
      if (pool.length === 0) break  // out of distinct recyclable posts (hard DB limit)
      const cand = pool[Math.floor(Math.random() * pool.length)]  // RANDOM idea pick
      usedPostThisRun.add(cand.post_id)

      // Fresh clip: prefer one never paired with this post; else reuse (near-dupe) to still hit 8.
      const fresh = footage.filter(f => !cand.usedKeys.has(f.r2_key))
      const isDupe = fresh.length === 0
      const chosen = pickFromUsage(isDupe ? footage : fresh, clipUsage)
      clipUsage.set(chosen.r2_key, (clipUsage.get(chosen.r2_key) ?? 0) + 1)
      const clipIndex = footage.findIndex(f => f.r2_key === chosen.r2_key) + 1

      let clipId = r2KeyToClipId.get(chosen.r2_key) ?? null
      if (!clipId) {
        const { data: nc } = await supabaseAdmin
          .from('model_clips')
          .insert({ model_id: model.id, r2_key: chosen.r2_key, filename: chosen.label ?? chosen.r2_key.split('/').pop(), duration_seconds: chosen.trim_end ?? null, tags: chosen.tags ?? [] })
          .select('id').single()
        if (nc) { clipId = (nc as { id: string }).id; r2KeyToClipId.set(chosen.r2_key, clipId) }
      }

      const placeholder = options.length > 0 ? options[Math.floor(Math.random() * options.length)] : ''
      const pick = await pickTemplate(tagsByPost.get(cand.post_id) ?? [], model.niches)
      const personalizedText = pick.fixedLines
        ? resolveMemeText(pick.fixedLines, placeholder)
        : cand.text.replace(/\[placeholder\]/gi, placeholder)

      const r = await insertVideoJobWithSlot(model.id, {
        post_id: cand.post_id,
        model_id: model.id,
        clip_id: clipId,
        clip_index: clipIndex,
        duration_seconds: pick.durationSec ?? 5,
        template_id: pick.templateId,
        original_template: cand.text,
        personalized_text: personalizedText,
        status: 'pending',
      })
      if (r.status === 'created') { filled++; if (isDupe) nearDupes++ }
      else if (r.status === 'error') console.error(`[emergency-fill] @${model.fansly_username} insert error: ${r.error}`)
      // skipped_duplicate: a concurrent writer made the post active — just move on to another post.
    }

    totalFilled += filled
    totalNearDupes += nearDupes
    const short = needed - filled
    if (short > 0) totalShortfall += short
    perModel.push({
      handle: model.fansly_username,
      needed,
      filled,
      nearDupes,
      note: short > 0 ? `only ${candidates.length} recyclable posts` : null,
    })
    console.log(`[emergency-fill] @${model.fansly_username}: +${filled}/${needed}${nearDupes ? ` (${nearDupes} near-dupe)` : ''}`)
  }

  const totals = { modelsBelow, filled: totalFilled, shortfall: totalShortfall, nearDupes: totalNearDupes }
  await setStatus({ running: false, phase: 'done', finished_at: new Date().toISOString(), totals, per_model: perModel, error: null })

  if (modelsBelow === 0) {
    await sendTelegram('🚨 <b>Emergency fill</b>: every model already projects to 8+ — nothing to do.').catch(() => {})
  } else {
    const lines = [`🚨 <b>Emergency fill done</b>`, `Topped up ${modelsBelow} model(s) — +${totalFilled} videos queued.`]
    const shorts = perModel.filter(m => m.filled < m.needed)
    if (shorts.length) lines.push(`⚠️ Couldn't fully fill: ` + shorts.map(m => `@${m.handle} (${m.filled}/${m.needed})`).join(', '))
    if (totalNearDupes) lines.push(`↺ ${totalNearDupes} reused-clip near-dupe(s).`)
    await sendTelegram(lines.join('\n')).catch(() => {})
  }
  console.log(`[emergency-fill] done — models ${modelsBelow}, filled ${totalFilled}, shortfall ${totalShortfall}, near-dupes ${totalNearDupes}`)
}
