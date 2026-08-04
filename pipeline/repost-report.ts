/**
 * repost-report.ts — publishes the repost-library review pages to R2 and links them on Telegram.
 *
 * One fleet page + one page per model, rebuilt after every scan (and on demand via
 * POST /repost-pages). Same information design as the local Round-1 pages Vito reviewed:
 * one card per DISTINCT video (never a duplicate — that was his explicit ask), best views,
 * watch share, airing history, retired greyed out. Thumbnails are ffmpeg stills pulled from the
 * R2 library, embedded as data URIs so each page is a single self-contained file.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { supabaseAdmin } from '../lib/supabase'
import { uploadToR2, getSignedVideoUrl } from '../lib/r2'
import { sendTelegram } from '../lib/telegram'

const ffmpegBin = () => (process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg')

const CSS = `body{background:#0d0f14;color:#e8eaf0;font:15px -apple-system,sans-serif;padding:28px;max-width:1400px;margin:0 auto}
h1{letter-spacing:-.5px}p,.f{color:#8b93a7;line-height:1.6}
.f{background:#151824;border:1px solid #232840;border-radius:12px;padding:14px 18px;margin:16px 0 24px}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
.c{background:#151824;border:1px solid #232840;border-radius:12px;overflow:hidden}
.c.retired{opacity:.45}
img.t{width:100%;aspect-ratio:9/16;object-fit:cover;display:block;background:#000}
.m{padding:10px 12px}.v{font-size:16px;font-weight:800;color:#6fd89a}
.s{color:#8b93a7;font-size:12px;line-height:1.5}
.air{background:#2a2318;border:1px solid #6b5a2a;color:#f0c060;font-size:11px;padding:4px 7px;border-radius:6px;margin-top:6px}
.ret{background:#2a1a1a;border:1px solid #6b3a3a;color:#ff9aa4;font-size:11px;padding:4px 7px;border-radius:6px;margin-top:6px}
table{width:100%;border-collapse:collapse}th{text-align:left;color:#6c7590;font-size:11px;text-transform:uppercase;padding:0 10px 8px;border-bottom:1px solid #232840}
td{padding:8px 10px;border-bottom:1px solid #1c2133;font-size:13px;color:#aab2c5}
.mn{color:#e8ecf5;font-weight:600}.r{text-align:right}.w{color:#6fd89a;font-weight:700}
a{color:#7fc4ff;text-decoration:none}tr:hover td{background:#151824}`

type VideoRow = {
  id: string; model_number: number; r2_key: string | null; duration_sec: number | null
  best_media_offer_id: string; best_fyp_views: number; best_watch_share: number | null
  score: number; first_posted_at: string | null; last_aired_at: string | null
  airings_total: number; retired: boolean; retired_reason: string | null
}

async function thumbDataUri(r2Key: string, tmp: string): Promise<string | null> {
  try {
    const url = await getSignedVideoUrl(r2Key, 600)
    const local = path.join(tmp, path.basename(r2Key))
    const res = await fetch(url)
    if (!res.ok) return null
    fs.writeFileSync(local, Buffer.from(await res.arrayBuffer()))
    const jpg = `${local}.jpg`
    execFileSync(ffmpegBin(), ['-v', 'error', '-y', '-ss', '0.5', '-i', local, '-frames:v', '1', '-vf', 'scale=270:-2', '-q:v', '6', jpg])
    const b64 = fs.readFileSync(jpg).toString('base64')
    fs.rmSync(local, { force: true }); fs.rmSync(jpg, { force: true })
    return `data:image/jpeg;base64,${b64}`
  } catch { return null }
}

export async function publishRepostPages(): Promise<string> {
  const { data: models } = await supabaseAdmin.from('trends_models')
    .select('fansly_username, model_number').not('model_number', 'is', null).order('model_number')
  const { data: vids } = await supabaseAdmin.from('repost_videos')
    .select('*').order('score', { ascending: false })
  const videos = (vids ?? []) as VideoRow[]
  const byModel = new Map<number, VideoRow[]>()
  for (const v of videos) (byModel.get(v.model_number) ?? byModel.set(v.model_number, []).get(v.model_number)!).push(v)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp_pages_'))
  const stamp = new Date().toISOString().slice(0, 10)
  const fleetRows: string[] = []

  for (const m of (models ?? []) as Array<{ fansly_username: string; model_number: number }>) {
    const list = byModel.get(m.model_number) ?? []
    if (!list.length) continue
    const active = list.filter(v => !v.retired)

    const cards = await Promise.all(list.slice(0, 120).map(async (v, i) => {
      const thumb = v.r2_key ? await thumbDataUri(v.r2_key, tmp) : null
      const play = v.r2_key ? await getSignedVideoUrl(v.r2_key, 7 * 86400).catch(() => null) : null
      return `<div class="c${v.retired ? ' retired' : ''}">
        ${thumb ? (play ? `<a href="${play}" target="_blank"><img class="t" src="${thumb}"></a>` : `<img class="t" src="${thumb}">`) : '<div class="t"></div>'}
        <div class="m">
          <div class="v">#${i + 1} · ${v.best_fyp_views.toLocaleString()} FYP views</div>
          <div class="s">watched ${v.best_watch_share != null ? Math.round(v.best_watch_share * 100) + '%' : '—'} of ${v.duration_sec ?? '?'}s · score ${v.score.toLocaleString()}</div>
          <div class="s">first ${v.first_posted_at?.slice(0, 10) ?? '—'} · last aired ${v.last_aired_at?.slice(0, 10) ?? '—'}</div>
          <div class="air">⟲ ${v.airings_total} airing${v.airings_total === 1 ? '' : 's'}</div>
          ${v.retired ? `<div class="ret">⛔ retired — ${v.retired_reason ?? ''}</div>` : ''}
        </div>
      </div>`
    }))

    const html = `<!doctype html><meta charset="utf-8"><title>Reposts — @${m.fansly_username}</title><style>${CSS}</style>
<h1>Repost library — @${m.fansly_username}</h1>
<div class="f"><b>${list.length}</b> distinct videos · <b>${active.length}</b> in rotation ·
<b>${list.length - active.length}</b> retired · updated ${stamp}. One card per REAL video — repeat
airings of the same clip are folded into their card's airing count, never shown twice.</div>
<div class="g">${cards.join('')}</div>`
    await uploadToR2(`reposts/pages/${m.fansly_username.toLowerCase()}.html`, Buffer.from(html), 'text/html')

    fleetRows.push(`<tr><td class="mn">#${m.model_number} @${m.fansly_username}</td>
      <td class="r w">${active.length}</td><td class="r">${list.length - active.length}</td>
      <td class="r">${Math.max(...list.map(v => v.best_fyp_views)).toLocaleString()}</td>
      <td><a href="${await getSignedVideoUrl(`reposts/pages/${m.fansly_username.toLowerCase()}.html`, 7 * 86400).catch(() => '#')}">open ↗</a></td></tr>`)
  }
  fs.rmSync(tmp, { recursive: true, force: true })

  const totalActive = videos.filter(v => !v.retired).length
  const fleet = `<!doctype html><meta charset="utf-8"><title>Repost library — fleet</title><style>${CSS}</style>
<h1>Repost library — fleet</h1>
<div class="f"><b>${totalActive}</b> distinct videos in rotation · ${videos.length - totalActive} retired · updated ${stamp}.
Duplicates are matched by picture fingerprint, so one card = one real video, always.</div>
<table><tr><th>Model</th><th class="r">In rotation</th><th class="r">Retired</th><th class="r">Best video</th><th></th></tr>${fleetRows.join('')}</table>`
  await uploadToR2('reposts/pages/_fleet.html', Buffer.from(fleet), 'text/html')

  const link = await getSignedVideoUrl('reposts/pages/_fleet.html', 7 * 86400).catch(() => null)
  const msg = `📄 repost pages rebuilt: ${totalActive} videos in rotation across ${fleetRows.length} models` + (link ? `\n${link}` : '')
  await sendTelegram(`<b>FanslyTrends</b> ${msg}`).catch(() => {})
  return msg
}
