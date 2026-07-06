/**
 * Weekly repost automation (Wave C, user decisions locked in the V3 rounds):
 *   top 5 media per model per week by FYP views · one repost per weekday Mon–Fri ·
 *   INSIDE the 4/day cap (day full → skip) · <5 performers → skip days · per-media
 *   cooldown 14 days ("repost every 2–3 weeks") · video DOWNLOADED from FanCore and
 *   watermark-cropped (bottom strip), never matched back to R2 originals.
 *
 * Repost jobs skip rendering entirely: inserted as status='approved' with output_r2_key
 * preset — the existing post pool + honest verification handle everything else.
 */

import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { supabaseAdmin } from '../lib/supabase'
import { uploadToR2 } from '../lib/r2'
import { sendTelegram } from '../lib/telegram'
import { getTakenSlots, FIXED_SLOTS, MIN_BUFFER_MS } from '../lib/scheduling'
import { withFanCorePage, fetchFypMedia } from './fyp-analytics'

const ffmpegBin = () => (process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg')
const COOLDOWN_DAYS = 14

type Pick = { mediaId: string; fypViews: number }

// Top-5 by FYP views from the latest snapshot per media, excluding recently reposted.
async function pickTopMedia(modelNumber: number): Promise<Pick[]> {
  const since = new Date(Date.now() - 35 * 86400_000).toISOString()
  const { data: stats } = await supabaseAdmin
    .from('fyp_media_stats')
    .select('media_id, fyp_views, captured_at')
    .eq('model_id', modelNumber)
    .gte('captured_at', since)
    .order('captured_at', { ascending: false })
  if (!stats?.length) return []

  const latest = new Map<string, number>()
  for (const row of stats as Array<{ media_id: string; fyp_views: number }>) {
    if (!latest.has(row.media_id)) latest.set(row.media_id, row.fyp_views)
  }

  const cooldownSince = new Date(Date.now() - COOLDOWN_DAYS * 86400_000).toISOString()
  const { data: recent } = await supabaseAdmin
    .from('repost_ledger')
    .select('media_id')
    .eq('model_id', modelNumber)
    .gte('reposted_at', cooldownSince)
  const excluded = new Set((recent ?? []).map(r => (r as { media_id: string }).media_id))

  return [...latest.entries()]
    .filter(([id]) => !excluded.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([mediaId, fypViews]) => ({ mediaId, fypViews }))
}

// First free fixed slot ON a specific UTC date (cap is law: day full → null).
function freeSlotOnDay(taken: Set<string>, day: Date): Date | null {
  const earliest = Date.now() + MIN_BUFFER_MS
  for (const slot of FIXED_SLOTS) {
    const candidate = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), slot.hour, slot.minute, 0, 0))
    if (candidate.getTime() <= earliest) continue
    if (!taken.has(candidate.toISOString())) return candidate
  }
  return null
}

// Download a specific media via the FYP Media grid: click its card (the media_offer_id is
// rendered on the card), read the player's <video src> (FanCore's /fansly-asset proxy of the
// signed Fansly CDN URL), and fetch it with the session's cookies.
async function downloadMedia(handle: string, mediaId: string, destPath: string): Promise<void> {
  await withFanCorePage(handle, async page => {
    await page.getByText('FYP Analytics', { exact: true }).first().click()
    await page.waitForTimeout(2_000)
    await page.locator('button[data-fyp-tab="media"]').click()
    await page.waitForTimeout(2_500)

    // lazy-scroll until the card with this media id is present
    for (let s = 0; s < 25; s++) {
      const found = await page.evaluate((id: string) => document.body.innerText.includes(id), mediaId)
      if (found) break
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight)
        document.querySelectorAll('main, [class*="overflow-y"], [class*="scroll"]').forEach(el => el.scrollTo(0, el.scrollHeight))
      })
      await page.waitForTimeout(500)
    }

    const clicked = await page.evaluate((id: string) => {
      const walker = document.createTreeWalker(document.body, 4)
      let node: Node | null
      while ((node = walker.nextNode())) {
        if (!((node as Text).textContent ?? '').includes(id)) continue
        let el: HTMLElement | null = (node as Text).parentElement
        for (let d = 0; d < 8 && el; d++, el = el.parentElement) {
          if (el.classList.contains('media-card') || (el.className || '').toString().includes('media-card')) {
            el.click()
            return true
          }
        }
      }
      return false
    }, mediaId)
    if (!clicked) throw new Error(`media card ${mediaId} not found in FYP grid`)

    // wait for the player video to mount with a src
    let videoSrc: string | null = null
    for (let i = 0; i < 20 && !videoSrc; i++) {
      await page.waitForTimeout(500)
      videoSrc = await page.evaluate(() => {
        const v = Array.from(document.querySelectorAll('video')).find(x => (x.currentSrc || x.src) && x.getBoundingClientRect().height > 50)
        return v ? (v.currentSrc || v.src) : null
      })
    }
    if (!videoSrc) throw new Error(`player video src never appeared for ${mediaId}`)

    const res = await page.context().request.get(videoSrc, { timeout: 120_000 })
    if (!res.ok()) throw new Error(`video download HTTP ${res.status()}`)
    fs.writeFileSync(destPath, await res.body())
    if (fs.statSync(destPath).size < 20_000) throw new Error('downloaded file suspiciously small')
  })
}

// Crop the Fansly watermark strip (bottom ~7.5%) and re-cover to 1080×1920 (slight zoom).
// Fansly re-watermarks with the current handle on post, so this prevents double-watermarking.
function cropWatermark(src: string, dest: string): void {
  execSync(
    `${ffmpegBin()} -y -i "${src}" -vf "crop=iw:ih*0.925:0:0,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" ` +
    `-c:v libx264 -preset veryfast -crf 21 -pix_fmt yuv420p -c:a copy "${dest}"`,
    { stdio: 'pipe', timeout: 300_000 },
  )
}

export async function runWeeklyRepostPick(opts: { dry?: boolean; onlyHandle?: string } = {}): Promise<string> {
  const dry = opts.dry ?? false
  const { data: models } = await supabaseAdmin
    .from('trends_models')
    .select('id, fansly_username, model_number')
    .not('model_number', 'is', null)
    .order('model_number')
  if (!models?.length) return 'repost pick: no models'

  const targets = (models as Array<{ id: string; fansly_username: string; model_number: number }>)
    .filter(m => !opts.onlyHandle || m.fansly_username.toLowerCase() === opts.onlyHandle.toLowerCase())

  // The coming Mon..Fri (UTC)
  const now = new Date()
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7 || 7)) // next Monday
  const weekdays = Array.from({ length: 5 }, (_, i) => {
    const d = new Date(monday)
    d.setUTCDate(d.getUTCDate() + i)
    return d
  })

  let queued = 0
  let skippedDayFull = 0
  let skippedShort = 0
  const failures: string[] = []
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repost_'))

  try {
    for (const model of targets) {
      const picks = await pickTopMedia(model.model_number)
      if (picks.length === 0) { skippedShort += 5; continue }
      if (picks.length < 5) skippedShort += 5 - picks.length
      if (dry) {
        console.log(`[repost] DRY @${model.fansly_username}: ${picks.map(p => `${p.mediaId}(${p.fypViews})`).join(', ')}`)
        queued += picks.length
        continue
      }

      const taken = await getTakenSlots(model.id)
      for (let i = 0; i < picks.length && i < weekdays.length; i++) {
        const pick = picks[i]
        const slot = freeSlotOnDay(taken, weekdays[i])
        if (!slot) { skippedDayFull++; continue }
        try {
          const raw = path.join(tmp, `${pick.mediaId}.mp4`)
          const cropped = path.join(tmp, `${pick.mediaId}_c.mp4`)
          await downloadMedia(model.fansly_username, pick.mediaId, raw)
          cropWatermark(raw, cropped)
          const dateTag = slot.toISOString().slice(0, 10).replace(/-/g, '')
          const r2Key = `reposts/${model.fansly_username.toLowerCase()}/${pick.mediaId}-${dateTag}.mp4`
          await uploadToR2(r2Key, fs.readFileSync(cropped), 'video/mp4')

          const { data: job, error } = await supabaseAdmin.from('video_jobs').insert({
            model_id: model.id,
            status: 'approved',
            output_r2_key: r2Key,
            scheduled_for: slot.toISOString(),
            duration_seconds: 5,
            is_repost: true,
            source_media_id: pick.mediaId,
            // display-only fields (NOT NULL in schema; no source trends_post for reposts)
            original_template: '[repost]',
            personalized_text: `♻️ repost of top FYP video (${pick.fypViews} views)`,
          }).select('id').single()
          if (error) throw new Error(`job insert: ${error.message}`)

          await supabaseAdmin.from('repost_ledger').insert({
            model_id: model.model_number, media_id: pick.mediaId, job_id: (job as { id: string }).id,
          })
          taken.add(slot.toISOString())
          queued++
          console.log(`[repost] ✓ @${model.fansly_username} ${pick.mediaId} (${pick.fypViews} views) → ${slot.toISOString()}`)
        } catch (e) {
          failures.push(`@${model.fansly_username}/${pick.mediaId}: ${(e as Error).message.slice(0, 80)}`)
          console.error(`[repost] ✗ @${model.fansly_username} ${pick.mediaId}:`, (e as Error).message.slice(0, 120))
        } finally {
          fs.rmSync(path.join(tmp, `${pick.mediaId}.mp4`), { force: true })
          fs.rmSync(path.join(tmp, `${pick.mediaId}_c.mp4`), { force: true })
        }
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  const summary = `♻️ <b>Repost pick${dry ? ' (DRY)' : ''}</b>: ${queued} queued across ${targets.length} models` +
    ` · day-full skips: ${skippedDayFull} · short-roster skips: ${skippedShort}` +
    (failures.length ? `\n✗ ${failures.slice(0, 6).join('\n✗ ')}` : '')
  console.log(`[repost] ${summary.replace(/<[^>]+>/g, '')}`)
  await sendTelegram(summary).catch(() => {})
  return summary
}
