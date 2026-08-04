/**
 * repost-scan.ts — fortnightly back-catalogue scan (Wave 3 automated reposting, 04.08.2026).
 *
 * For every Active model: enumerate her Posts wall, read lifetime FYP stats for eligible videos,
 * and sync the repost library (repost_videos / repost_airings in Supabase + video files in R2).
 * Identity is the PICTURE fingerprint, never the Fansly id — Fansly re-encodes on ingest, so a
 * repost of the same clip arrives with a fresh id and fresh bytes. That is how one clip aired 8×
 * and looked like 8 videos. The fingerprint match here is what folds it back into one row.
 *
 * Auth: same pattern as fansly-scheduler-check.ts — Fansly blocks headless login from datacenter
 * IPs, so header sets are minted locally (scripts/mint-sched-headers.mjs) and replayed here with a
 * refreshed fansly-client-ts. A dead set is reported (🔑 in the digest), never silently skipped.
 *
 * Endpoint contract (discovered + verified 03.08, fansly-onboarding-automation
 * scripts/repost-candidates.mjs):
 *   /account/walls?accountId=            → walls; videos live on the wall named "Posts"
 *   /timelinenew/<acct>?before=<cursor>&after=0&wallId=  → page until posts comes back EMPTY
 *   /it/moie/statsnew?mediaOfferId=&beforeDate=&afterDate=&period=  → period == whole range ⇒ ONE
 *     datapoint of lifetime totals; stats type 0 = FYP promotion (the only number Vito counts)
 *
 * Rules (Vito, 03–04.08): eligible = video ≥30d old with ≥20 likes; qualifies at ≥1,000 lifetime
 * FYP views (near-misses re-checked every scan by construction); retire when the newest airing is
 * >30d old and pulled <500 views; models with nothing ≥30d simply yield nothing.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { supabaseAdmin } from '../lib/supabase'
import { sendTelegram } from '../lib/telegram'
import { uploadToR2 } from '../lib/r2'
import { loadSchedHeaders, freshHeaders, type SchedHeaderSet } from './fansly-scheduler-check'

const ffmpegBin = () => (process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg')
const API = 'https://apiv3.fansly.com/api/v1'
const PACE_MS = 3500
const RETRIES = [15_000, 45_000, 120_000]
const MIN_LIKES = 20
const MIN_VIEWS = 1000
const MIN_AGE_MS = 30 * 86400_000
const RETIRE_VIEWS = 500
const LIFETIME_MS = 500 * 86400_000
const HAMMING = 18            // 3×64-bit signature; 6 bits per frame hash
const DUR_TOL = 1.0

let lastCall = 0
async function fanslyGet(hs: SchedHeaderSet, pathq: string, expectKey: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + PACE_MS - Date.now()
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    lastCall = Date.now()
    const res = await fetch(`${API}${pathq}${pathq.includes('?') ? '&' : '?'}ngsw-bypass=true`, { headers: freshHeaders(hs.headers) })
    if (res.status === 401 || res.status === 403) throw new Error('SESSION_EXPIRED')
    const json = res.status === 200 ? await res.json().catch(() => null) as { response?: Record<string, unknown> } | null : null
    const body = json?.response
    // Fansly answers degraded/unauthenticated requests with HTTP 200 and an unrelated empty shape
    // (e.g. {mediaOfferSuggestions:[]}) — never treat a missing expected key as an empty result.
    if (body && Object.prototype.hasOwnProperty.call(body, expectKey)) return body
    if (attempt >= RETRIES.length) {
      throw new Error(`degraded after retries: ${pathq.slice(0, 60)} (HTTP ${res.status}, keys ${Object.keys(body ?? {}).join(',') || 'none'})`)
    }
    await new Promise(r => setTimeout(r, RETRIES[attempt]))
  }
}

// ─── wall enumeration (port of repost-candidates.mjs stage 1 — verified 535/535 on yasmin) ────

type WallVideo = {
  mediaOfferId: string
  postId: string | null
  likes: number
  createdAtMs: number
  durationSec: number | null
  location: string | null
}

const toMs = (t: unknown): number => { const n = Number(t) || 0; return n && n < 1e12 ? n * 1000 : n }

function metaOf(am: Record<string, any>): Record<string, any> {
  try { return JSON.parse(am?.media?.metadata || '{}') } catch { return {} }
}
function bestLocation(am: Record<string, any>): string | null {
  const cands = [...(am?.media?.locations || []), ...((am?.media?.variants || []) as Array<Record<string, any>>).flatMap(v => v.locations || [])]
  return (cands.find((l: Record<string, any>) => l?.location) as Record<string, any> | undefined)?.location ?? null
}

async function enumerateWall(hs: SchedHeaderSet, accountId: string): Promise<{ wallName: string; videos: WallVideo[] }> {
  // /account/walls returns a bare array, so fanslyGet's expected-key check doesn't apply — fetch
  // directly and validate the array shape instead.
  const wres = await fetch(`${API}/account/walls?accountId=${accountId}&ngsw-bypass=true`, { headers: freshHeaders(hs.headers) })
  if (wres.status === 401 || wres.status === 403) throw new Error('SESSION_EXPIRED')
  const wjson = await wres.json().catch(() => null) as { response?: Array<Record<string, any>> } | null
  const wallList = Array.isArray(wjson?.response) ? wjson!.response! : []
  if (!wallList.length) throw new Error('walls came back empty — likely unauthenticated (Fansly returns empty shapes, not 401)')
  // Vito's ruling: posted videos are ALWAYS on the wall named "Posts" — never guess another wall.
  const wall = wallList.find(w => String(w.name ?? '').trim().toLowerCase() === 'posts')
  if (!wall) throw new Error(`no wall named "Posts" (found: ${wallList.map(w => w.name).join(', ') || 'none'})`)

  const media = new Map<string, Record<string, any>>()
  const postOf = new Map<string, string>()
  let cursor = '0'
  for (let pageNo = 1; pageNo <= 400; pageNo++) {
    const r = await fanslyGet(hs, `/timelinenew/${accountId}?before=${cursor}&after=0&wallId=${wall.id}&contentSearch=`, 'posts')
    const posts = (r.posts as Array<Record<string, any>>) || []
    if (!posts.length) break
    for (const m of (r.accountMedia as Array<Record<string, any>>) || []) media.set(String(m.id), m)
    const bundles = (r.accountMediaBundles as Array<Record<string, any>>) || []
    for (const p of posts) {
      for (const a of p.attachments || []) {
        const bundle = bundles.find(b => String(b.id) === String(a.contentId))
        const ids = bundle ? (bundle.accountMediaIds || (bundle.bundleContent || []).map((x: Record<string, any>) => x.accountMediaId) || []) : [a.contentId]
        for (const id of ids) if (!postOf.has(String(id))) postOf.set(String(id), String(p.id))
      }
    }
    cursor = String(posts[posts.length - 1].id)
  }

  const videos: WallVideo[] = []
  for (const [id, am] of media) {
    if (!String(am?.media?.mimetype || '').startsWith('video')) continue
    const meta = metaOf(am)
    videos.push({
      mediaOfferId: id,
      postId: postOf.get(id) ?? null,
      likes: Number(am?.likeCount ?? -1),
      createdAtMs: toMs(am?.createdAt),
      durationSec: Number(meta.duration) || null,
      location: bestLocation(am),
    })
  }
  return { wallName: String(wall.name), videos }
}

// ─── lifetime FYP stats (type 0 only) ─────────────────────────────────────────────────────────

async function fetchStats(hs: SchedHeaderSet, mediaOfferId: string): Promise<{ fypViews: number; avgSec: number }> {
  const now = Date.now()
  const r = await fanslyGet(hs,
    `/it/moie/statsnew?mediaOfferId=${mediaOfferId}&beforeDate=${now}&afterDate=${now - LIFETIME_MS}&period=${LIFETIME_MS}`,
    'dataset')
  let views = 0, ms = 0
  for (const d of ((r.dataset as Record<string, any>)?.datapoints as Array<Record<string, any>>) || []) {
    for (const s of d.stats || []) {
      if (s.type !== 0) continue
      views += s.views || 0
      ms += s.interactionTime || 0
    }
  }
  return { fypViews: views, avgSec: views ? ms / views / 1000 : 0 }
}

// ─── fingerprinting (port of repost-candidates.mjs / dedupe-media.mjs) ────────────────────────

function frameHash(file: string, dur: number): string | null {
  const bits: string[] = []
  for (const p of [0.2, 0.5, 0.8]) {
    const t = Math.max(0.05, dur * p)
    let buf: Buffer
    try {
      buf = execFileSync(ffmpegBin(), ['-v', 'error', '-y', '-ss', t.toFixed(2), '-i', file,
        '-frames:v', '1', '-vf', 'scale=8:8,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 })
    } catch { return null }
    if (buf.length < 64) return null
    const px = [...buf.subarray(0, 64)]
    const mean = px.reduce((s, x) => s + x, 0) / 64
    bits.push(px.map(x => (x >= mean ? 1 : 0)).join(''))
  }
  return bits.join('')
}
function hdist(x: string, y: string): number {
  if (!x || !y || x.length !== y.length) return 999
  let d = 0
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) d++
  return d
}
const fpHash = (fp: string) => createHash('sha1').update(fp).digest('hex').slice(0, 16)

// ─── per-model scan ───────────────────────────────────────────────────────────────────────────

export interface ScanModelResult {
  handle: string
  ok: boolean
  error?: string
  wallVideos?: number
  measured?: number
  newVideos?: number
  newAirings?: number
  retired?: number
}

type DbVideo = {
  id: string; fingerprint: string; duration_sec: number | null
  best_fyp_views: number; last_aired_at: string | null; airings_total: number
}

export async function scanModel(handle: string, modelNumber: number): Promise<ScanModelResult> {
  const hs = await loadSchedHeaders(handle)
  if (!hs) return { handle, ok: false, error: 'no header set in R2 — run mint-sched-headers' }
  const accountId = hs.accountId
  if (!accountId) return { handle, ok: false, error: 'header set has no accountId' }

  try {
    const { videos } = await enumerateWall(hs, accountId)
    const cutoff = Date.now() - MIN_AGE_MS
    const eligible = videos.filter(v => v.likes >= MIN_LIKES && v.createdAtMs > 0 && v.createdAtMs <= cutoff)

    const { data: dbv } = await supabaseAdmin.from('repost_videos')
      .select('id, fingerprint, duration_sec, best_fyp_views, last_aired_at, airings_total')
      .eq('model_number', modelNumber)
    const dbVideos = (dbv ?? []) as DbVideo[]

    const videoIds = dbVideos.map(d => d.id)
    const { data: known } = videoIds.length
      ? await supabaseAdmin.from('repost_airings').select('media_offer_id, video_id').in('video_id', videoIds)
      : { data: [] }
    const knownAirings = new Map(((known ?? []) as Array<{ media_offer_id: string; video_id: string }>).map(a => [a.media_offer_id, a.video_id]))

    let measured = 0, newVideos = 0, newAirings = 0
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rescan_'))

    for (const v of eligible) {
      // Known airing → refresh its views (stats move); nothing else to do for it.
      const knownVid = knownAirings.get(v.mediaOfferId)
      const { fypViews, avgSec } = await fetchStats(hs, v.mediaOfferId)
      measured++
      const watchShare = v.durationSec ? Math.min(1, avgSec / v.durationSec) : 0

      if (knownVid) {
        await supabaseAdmin.from('repost_airings')
          .update({ fyp_views: fypViews, watch_share: watchShare })
          .eq('media_offer_id', v.mediaOfferId)
        continue
      }
      if (fypViews < MIN_VIEWS) continue   // near-miss: re-measured next scan by construction

      // New qualifier → download while the signed URL is fresh, fingerprint, match or insert.
      if (!v.location) continue
      const local = path.join(tmp, `${v.mediaOfferId}.mp4`)
      try {
        const res = await fetch(v.location)
        if (!res.ok) throw new Error(`download HTTP ${res.status}`)
        fs.writeFileSync(local, Buffer.from(await res.arrayBuffer()))
      } catch { continue }
      const fp = frameHash(local, v.durationSec ?? 5)
      if (!fp) { fs.rmSync(local, { force: true }); continue }

      const score = Math.round(fypViews * (0.5 + 0.5 * watchShare))
      const match = dbVideos.find(d =>
        Math.abs((d.duration_sec ?? 0) - (v.durationSec ?? 0)) <= DUR_TOL && hdist(d.fingerprint, fp) <= HAMMING)

      if (match) {
        // Another airing of a video we already hold — the self-correcting loop for our own reposts.
        // If the SCHEDULER booked this airing, it already wrote a placeholder row (media_offer_id
        // 'job:<id>') and already bumped airings_total — claim that placeholder instead of
        // inserting, or the airing gets counted twice.
        const { data: ph } = await supabaseAdmin.from('repost_airings')
          .select('id').eq('video_id', match.id).like('media_offer_id', 'job:%')
          .gte('posted_at', new Date(v.createdAtMs - 2 * 86400_000).toISOString())
          .lte('posted_at', new Date(v.createdAtMs + 2 * 86400_000).toISOString())
          .limit(1)
        const placeholder = (ph ?? [])[0] as { id: string } | undefined
        if (placeholder) {
          await supabaseAdmin.from('repost_airings').update({
            media_offer_id: v.mediaOfferId,
            posted_at: new Date(v.createdAtMs).toISOString(),
            fyp_views: fypViews, watch_share: watchShare,
          }).eq('id', placeholder.id)
        } else {
          await supabaseAdmin.from('repost_airings').upsert({
            video_id: match.id, media_offer_id: v.mediaOfferId,
            posted_at: new Date(v.createdAtMs).toISOString(),
            fyp_views: fypViews, watch_share: watchShare, source: 'scan',
          }, { onConflict: 'media_offer_id' })
        }
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
        if (!placeholder) { patch.airings_total = match.airings_total + 1; match.airings_total += 1 }
        if (!match.last_aired_at || v.createdAtMs > Date.parse(match.last_aired_at)) patch.last_aired_at = new Date(v.createdAtMs).toISOString()
        if (fypViews > match.best_fyp_views) { patch.best_fyp_views = fypViews; patch.best_media_offer_id = v.mediaOfferId; patch.best_watch_share = watchShare; patch.score = score }
        await supabaseAdmin.from('repost_videos').update(patch).eq('id', match.id)
        newAirings++
      } else {
        const r2Key = `reposts/library/${handle.toLowerCase()}/${fpHash(fp)}.mp4`
        await uploadToR2(r2Key, fs.readFileSync(local), 'video/mp4')
        const { data: ins, error } = await supabaseAdmin.from('repost_videos').insert({
          model_number: modelNumber, fingerprint: fp, duration_sec: v.durationSec, r2_key: r2Key,
          best_media_offer_id: v.mediaOfferId, best_fyp_views: fypViews, best_watch_share: watchShare,
          score, first_posted_at: new Date(v.createdAtMs).toISOString(),
          last_aired_at: new Date(v.createdAtMs).toISOString(), airings_total: 1,
        }).select('id, fingerprint, duration_sec, best_fyp_views, last_aired_at, airings_total').single()
        if (!error && ins) {
          dbVideos.push(ins as DbVideo)
          await supabaseAdmin.from('repost_airings').upsert({
            video_id: (ins as { id: string }).id, media_offer_id: v.mediaOfferId,
            posted_at: new Date(v.createdAtMs).toISOString(),
            fyp_views: fypViews, watch_share: watchShare, source: 'scan',
          }, { onConflict: 'media_offer_id' })
          newVideos++
        }
      }
      fs.rmSync(local, { force: true })
    }
    fs.rmSync(tmp, { recursive: true, force: true })

    // Retirement: newest airing is >30d old AND pulled under RETIRE_VIEWS.
    let retired = 0
    for (const d of dbVideos) {
      const { data: lastAir } = await supabaseAdmin.from('repost_airings')
        .select('posted_at, fyp_views').eq('video_id', d.id)
        .order('posted_at', { ascending: false }).limit(1)
      const la = (lastAir ?? [])[0] as { posted_at: string; fyp_views: number } | undefined
      if (la && Date.parse(la.posted_at) < Date.now() - MIN_AGE_MS && la.fyp_views < RETIRE_VIEWS) {
        const { data: upd } = await supabaseAdmin.from('repost_videos')
          .update({ retired: true, retired_reason: `last airing ${la.fyp_views} views (<${RETIRE_VIEWS}) after 30d`, updated_at: new Date().toISOString() })
          .eq('id', d.id).eq('retired', false).select('id')
        retired += (upd ?? []).length
      }
    }

    return { handle, ok: true, wallVideos: videos.length, measured, newVideos, newAirings, retired }
  } catch (e) {
    const msg = (e as Error).message
    return { handle, ok: false, error: msg === 'SESSION_EXPIRED' ? '🔑 session expired — re-run mint-sched-headers' : msg.slice(0, 160) }
  }
}

// ─── fleet run ────────────────────────────────────────────────────────────────────────────────

export async function runRepostScan(onlyHandle?: string): Promise<string> {
  const { data: models } = await supabaseAdmin
    .from('trends_models')
    .select('fansly_username, model_number')
    .not('model_number', 'is', null)
    .order('model_number')
  const targets = ((models ?? []) as Array<{ fansly_username: string; model_number: number }>)
    .filter(m => !onlyHandle || m.fansly_username.toLowerCase() === onlyHandle.toLowerCase())

  const results: ScanModelResult[] = []
  for (const m of targets) {
    const r = await scanModel(m.fansly_username, m.model_number)
    results.push(r)
    console.log(`[repost-scan] ${r.ok ? '✓' : '✗'} @${m.fansly_username}: ` +
      (r.ok ? `${r.wallVideos} videos, ${r.measured} measured, +${r.newVideos} new, +${r.newAirings} airings, ${r.retired} retired` : r.error))
  }

  const ok = results.filter(r => r.ok)
  const failed = results.filter(r => !r.ok)
  const sum = (k: keyof ScanModelResult) => ok.reduce((a, r) => a + (Number(r[k]) || 0), 0)
  const summary = `🔁 repost scan: ${ok.length}/${results.length} models · +${sum('newVideos')} new videos · ` +
    `+${sum('newAirings')} airings recognised · ${sum('retired')} retired` +
    (failed.length ? `\n⚠️ failed: ${failed.map(f => `@${f.handle} (${f.error})`).join(' · ')}` : '')
  await sendTelegram(`<b>FanslyTrends</b> ${summary}`).catch(() => {})
  return summary
}
