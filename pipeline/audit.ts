/**
 * Scheduler audit — enforces the 4 videos/day/model rule end to end.
 *
 * Per model:
 *  1. DEFICITS  — fixed slots in the horizon with no video_job and no FanCore post → refill by
 *     inserting new jobs from RANDOM eligible matched ideas (insertVideoJobWithSlot lands each
 *     one in the earliest free slot, which are exactly the deficits).
 *  2. EXTRAS    — FanCore-side anomalies from scheduled_posts: same-second stacks
 *     (post_count > 1, the double-post bug) and posts at non-fixed times.
 *  3. MOVER     — optionally moves stacked duplicates to the next free slot via FanCore's
 *     "Edit scheduled post" modal (member account per model; capped per run).
 *  4. Telegram summary — totals first, per-model lines only for anomalies.
 */

import fs from 'fs'
import { chromium, type Browser, type Page } from 'playwright'
import { supabaseAdmin } from '../lib/supabase'
import { sendTelegram } from '../lib/telegram'
import { getTakenSlots, getNextSlot, insertVideoJobWithSlot, FIXED_SLOTS, MIN_BUFFER_MS } from '../lib/scheduling'
import { clipUsageMap, pickFromUsage } from '../lib/footage'
import {
  resolveMemberCreds, loginFanCore, createContext, getActiveModel,
  FANCORE_URL, SESSION_R2_KEY,
} from './post-video-job'

export type AuditOptions = { days?: number; refill?: boolean; moveExtras?: boolean; maxMoves?: number }

type ModelRow = {
  id: string
  fansly_username: string
  model_number: number | null
  niches: string[]
  placeholder_options: string[] | null
}

type AuditModelReport = {
  handle: string
  deficits: number
  refilled: number
  requeued: number
  refillShort: number // deficits we could not fill (no eligible ideas)
  missedToday: number // today's slots already unfillable (past the 45-min buffer)
  duplicateSlots: string[] // ISO timestamps with post_count > 1 on FanCore
  offSlots: string[] // FanCore posts at non-fixed times
  moved: number
  moveFailures: number
}

function horizonSlotKeys(days: number): string[] {
  const now = new Date()
  const keys: string[] = []
  for (let dayOffset = 0; dayOffset < days; dayOffset++) {
    const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset))
    for (const slot of FIXED_SLOTS) {
      keys.push(new Date(Date.UTC(
        base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), slot.hour, slot.minute, 0, 0,
      )).toISOString())
    }
  }
  return keys
}

const isFixedSlotTime = (iso: string): boolean => {
  const d = new Date(iso)
  return FIXED_SLOTS.some(s => d.getUTCHours() === s.hour && d.getUTCMinutes() === s.minute && d.getUTCSeconds() === 0)
}

// ─── Refill: insert new jobs from RANDOM eligible matched ideas ─────────────────────────────────

async function refillModel(model: ModelRow, deficitCount: number): Promise<{ refilled: number; requeued: number }> {
  const result = { refilled: 0, requeued: 0 }
  if (deficitCount <= 0) return result

  const { data: pipelineModel } = await supabaseAdmin
    .from('pipeline_models').select('id').ilike('handle', model.fansly_username).maybeSingle()
  if (!pipelineModel) return result

  type FootageRow = { id: string; r2_key: string; label: string | null; trim_end: number | null; tags: string[] }
  const [{ data: bank }, { data: clips }] = await Promise.all([
    supabaseAdmin.from('pipeline_content_bank').select('id, r2_key, label, trim_end, tags').eq('model_id', pipelineModel.id),
    supabaseAdmin.from('model_clips').select('id, r2_key').eq('model_id', model.id),
  ])
  const footage = (bank ?? []) as FootageRow[]
  if (footage.length === 0) return result
  const contentBankTags = new Set<string>()
  for (const item of footage) for (const t of (item.tags ?? [])) contentBankTags.add(t)
  const r2KeyToClipId = new Map(((clips ?? []) as Array<{ id: string; r2_key: string }>).map(c => [c.r2_key, c.id]))
  const clipUsage = await clipUsageMap(model.id, footage)

  const { data: ideas } = await supabaseAdmin
    .from('trends_ideas')
    .select('id, niches, tags, trends_posts(id, text_template, video_jobs(id, status, model_id, output_r2_key, post_fail_count))')
    .overlaps('niches', model.niches)
  if (!ideas?.length) return result

  // RANDOM pick (user decision): shuffle, then walk until the deficit is covered.
  const shuffled = [...(ideas as any[])].sort(() => Math.random() - 0.5)
  const usedPosts = new Set<string>()

  for (const rawIdea of shuffled) {
    if (result.refilled + result.requeued >= deficitCount) break
    const idea = rawIdea as { tags: string[]; trends_posts: { id: string; text_template: string | null; video_jobs: Array<{ id: string; status: string; model_id: string; output_r2_key: string | null; post_fail_count: number | null }> } | null }
    const post = idea.trends_posts
    if (!post?.text_template) continue
    if (usedPosts.has(post.id)) continue

    if (contentBankTags.size > 0) {
      const ideaTags = idea.tags ?? []
      if (ideaTags.length > 0 && !ideaTags.some(t => contentBankTags.has(t))) continue
    }

    const jobs = (post.video_jobs ?? []).filter(j => j.model_id === model.id)
    const hasActive = jobs.some(j => ['done', 'approved', 'posting', 'posted'].includes(j.status) && j.output_r2_key)
    const hasInFlight = jobs.some(j => ['pending', 'processing'].includes(j.status))
    if (hasActive || hasInFlight) continue

    const erroredJob = jobs.find(j => j.status === 'error')
    if (erroredJob) {
      // 3×-post-failed videos stay dead (user decision) — a NEW idea takes the slot instead.
      if ((erroredJob.post_fail_count ?? 0) >= 3) continue
      const { error } = await supabaseAdmin.from('video_jobs')
        .update({ status: 'pending', render_attempts: 0, post_fail_count: 0, started_at: null, error_message: null })
        .eq('id', erroredJob.id)
      if (!error) { result.requeued++; usedPosts.add(post.id) }
      continue
    }

    const chosen = pickFromUsage(footage, clipUsage)
    clipUsage.set(chosen.r2_key, (clipUsage.get(chosen.r2_key) ?? 0) + 1)
    const clipIndex = footage.findIndex(f => f.r2_key === chosen.r2_key) + 1
    let clipId = r2KeyToClipId.get(chosen.r2_key) ?? null
    if (!clipId) {
      const { data: newClip } = await supabaseAdmin.from('model_clips')
        .insert({ model_id: model.id, r2_key: chosen.r2_key, filename: chosen.label ?? chosen.r2_key.split('/').pop(), duration_seconds: chosen.trim_end ?? null, tags: chosen.tags ?? [] })
        .select('id').single()
      if (newClip) { clipId = newClip.id; r2KeyToClipId.set(chosen.r2_key, newClip.id) }
    }

    const options = model.placeholder_options ?? []
    const placeholder = options.length > 0 ? options[Math.floor(Math.random() * options.length)] : ''
    const res = await insertVideoJobWithSlot(model.id, {
      post_id: post.id,
      model_id: model.id,
      clip_id: clipId,
      clip_index: clipIndex,
      duration_seconds: 5,
      original_template: post.text_template,
      personalized_text: post.text_template.replace(/\[placeholder\]/gi, placeholder),
      status: 'pending',
    })
    if (res.status === 'created') { result.refilled++; usedPosts.add(post.id) }
  }
  return result
}

// ─── Mover: relocate stacked duplicate posts via FanCore's Edit modal ────────────────────────────

// FanCore's SCHEDULED FOR input format (UTC browser context): "DD/MM/YYYY, HH:mm"
function toFanCoreDateInput(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

// Card timestamps render as "M/D/YYYY, h:mm:ss AM/PM" in the UTC context.
function toCardTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'UTC', month: 'numeric', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  })
}

// Click the edit (pencil) control of the FIRST card showing cardTs, then wait for the modal.
async function openEditModalForCard(page: Page, cardTs: string): Promise<boolean> {
  const clicked = await page.evaluate((ts: string) => {
    const walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */)
    let node: Node | null
    while ((node = walker.nextNode())) {
      if (!((node as Text).textContent ?? '').includes(ts)) continue
      // climb to the card container: nearest ancestor that also contains a button/svg control
      let el: HTMLElement | null = (node as Text).parentElement
      for (let depth = 0; depth < 8 && el; depth++, el = el.parentElement) {
        const controls = el.querySelectorAll<HTMLElement>('button, [role="button"], svg')
        if (controls.length === 0) continue
        if (el.getBoundingClientRect().height > 400) break // climbed past the card into the list
        // the pencil sits top-right — pick the control closest to the card's top-right corner
        const rect = el.getBoundingClientRect()
        let best: HTMLElement | null = null
        let bestDist = Infinity
        controls.forEach(c => {
          const r = c.getBoundingClientRect()
          if (r.width === 0 && r.height === 0) return
          const dist = Math.hypot(rect.right - r.right, r.top - rect.top)
          if (dist < bestDist) { bestDist = dist; best = c }
        })
        if (best) {
          const clickable = (best as HTMLElement).closest('button, [role="button"]') ?? best
          ;(clickable as HTMLElement).click()
          return true
        }
      }
    }
    return false
  }, cardTs)
  if (!clicked) return false
  return page.locator('text=Edit scheduled post').first().isVisible({ timeout: 5_000 }).catch(() => false)
}

async function moveExtrasForModel(
  model: ModelRow,
  duplicateSlots: Array<{ iso: string; count: number }>,
  budget: { movesLeft: number },
  report: AuditModelReport,
): Promise<void> {
  if (duplicateSlots.length === 0 || budget.movesLeft <= 0) return
  const handle = model.fansly_username
  const memberCreds = await resolveMemberCreds(handle)
  const sessionKey = memberCreds ? `sessions/fancore-${handle.toLowerCase()}.json` : SESSION_R2_KEY

  let browser: Browser | null = null
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-zygote', '--disable-gpu'] })
    const { context } = await createContext(browser, sessionKey)
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)

    await page.goto(`${FANCORE_URL}/bulk-posts/already`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const hasLoginForm = await page.locator('input[name="password"]').isVisible({ timeout: 3_000 }).catch(() => false)
    if (page.url().includes('/signin') || hasLoginForm) {
      await loginFanCore(page, memberCreds)
      await page.goto(`${FANCORE_URL}/bulk-posts/already`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    }
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})

    if (memberCreds) {
      const active = await getActiveModel(page)
      if (active !== handle.toLowerCase()) throw new Error(`member active model @${active ?? 'none'} ≠ @${handle}`)
    } else {
      const modelEntry = page.getByText(`@${handle}`, { exact: true }).first()
      for (let i = 0; i < 10 && !(await modelEntry.isVisible().catch(() => false)); i++) {
        await page.evaluate(() => document.querySelectorAll('aside, [class*="sidebar"], [class*="overflow"]').forEach(el => el.scrollBy(0, 400)))
        await page.waitForTimeout(400)
      }
      await modelEntry.click({ timeout: 10_000 })
      await page.waitForTimeout(2_500)
    }

    // Open the "Scheduled (N)" filter so only pending scheduled cards are listed
    await page.locator('button').filter({ hasText: /^Scheduled \(\d+\)$/ }).first().click({ timeout: 10_000 })
    await page.waitForTimeout(1_000)

    let consecutiveFailures = 0
    for (const dup of duplicateSlots) {
      // Move count-1 posts off the stacked second, one at a time
      for (let i = 0; i < dup.count - 1; i++) {
        if (budget.movesLeft <= 0 || consecutiveFailures >= 2) return
        const cardTs = toCardTimestamp(dup.iso)

        // lazy-load until the card is present
        for (let s = 0; s < 20; s++) {
          const found = await page.evaluate((ts: string) => document.body.innerText.includes(ts), cardTs)
          if (found) break
          await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight)
            document.querySelectorAll('main, [class*="overflow-y"], [class*="scroll"]').forEach(el => el.scrollTo(0, el.scrollHeight))
          })
          await page.waitForTimeout(600)
        }

        const modalOpen = await openEditModalForCard(page, cardTs)
        if (!modalOpen) {
          consecutiveFailures++
          report.moveFailures++
          console.log(`[audit] @${handle}: could not open Edit modal for ${dup.iso}`)
          continue
        }

        const target = await getNextSlot(model.id)
        const dtValue = toFanCoreDateInput(target)
        // The modal's SCHEDULED FOR input — nearest input following the "SCHEDULED FOR" label
        const input = page.locator('text=SCHEDULED FOR').locator('xpath=following::input[1]')
        await input.fill(dtValue).catch(async () => {
          await input.evaluate((el: Element, v: string) => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
            setter.call(el, v)
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
          }, dtValue)
        })
        await page.waitForTimeout(300)
        await page.getByRole('button', { name: 'Save changes' }).click({ timeout: 5_000 })
        const modalClosed = await page.locator('text=Edit scheduled post').first()
          .waitFor({ state: 'hidden', timeout: 10_000 }).then(() => true).catch(() => false)

        if (!modalClosed) {
          consecutiveFailures++
          report.moveFailures++
          await page.keyboard.press('Escape').catch(() => {})
          continue
        }

        // Book-keep locally so getNextSlot stays consistent until the next scrape
        const targetIso = target.toISOString()
        if (model.model_number != null) {
          const { data: oldRow } = await supabaseAdmin.from('scheduled_posts')
            .select('id, post_count').eq('model_id', model.model_number).eq('scheduled_for', dup.iso).maybeSingle()
          if (oldRow) {
            await supabaseAdmin.from('scheduled_posts')
              .update({ post_count: Math.max(1, (oldRow as { post_count: number }).post_count - 1) })
              .eq('id', (oldRow as { id: number }).id)
          }
          await supabaseAdmin.from('scheduled_posts').insert({
            model_id: model.model_number, scheduled_for: targetIso, post_count: 1,
            platform: 'fancore', source: 'audit-move', status: 'scheduled',
          })
        }

        budget.movesLeft--
        report.moved++
        consecutiveFailures = 0
        console.log(`[audit] @${handle}: moved 1 post ${dup.iso} → ${targetIso}`)
        await sendTelegram(`🔀 <b>Audit</b>: @${handle} moved a stacked post ${dup.iso} → ${targetIso}`).catch(() => {})
        await page.waitForTimeout(1_000)
      }
    }
  } catch (e) {
    report.moveFailures++
    console.error(`[audit] @${handle} mover error:`, (e as Error).message)
  } finally {
    await browser?.close().catch(() => {})
  }
}

// ─── Main entry ──────────────────────────────────────────────────────────────────────────────────

export async function runSchedulerAudit(opts: AuditOptions = {}): Promise<string> {
  const days = opts.days ?? 3
  const refill = opts.refill ?? true
  const moveExtras = opts.moveExtras ?? false
  const budget = { movesLeft: opts.maxMoves ?? 10 }

  const { data: models } = await supabaseAdmin
    .from('trends_models')
    .select('id, fansly_username, model_number, niches, placeholder_options')
    .not('niches', 'is', null)
    .neq('niches', '{}')
    .order('model_number')
  if (!models?.length) return 'audit: no models'

  const horizon = horizonSlotKeys(days)
  const earliestFillable = Date.now() + MIN_BUFFER_MS
  const horizonEnd = horizon[horizon.length - 1]
  const reports: AuditModelReport[] = []

  for (const model of models as ModelRow[]) {
    const report: AuditModelReport = {
      handle: model.fansly_username, deficits: 0, refilled: 0, requeued: 0, refillShort: 0,
      missedToday: 0, duplicateSlots: [], offSlots: [], moved: 0, moveFailures: 0,
    }

    const taken = await getTakenSlots(model.id)
    const freeSlots = horizon.filter(k => !taken.has(k))
    const fillable = freeSlots.filter(k => new Date(k).getTime() > earliestFillable)
    report.missedToday = freeSlots.length - fillable.length
    report.deficits = fillable.length

    if (refill && fillable.length > 0) {
      const { refilled, requeued } = await refillModel(model, fillable.length)
      report.refilled = refilled
      report.requeued = requeued
      report.refillShort = fillable.length - refilled - requeued
    }

    // FanCore-side anomalies within the horizon
    if (model.model_number != null) {
      const { data: fcRows } = await supabaseAdmin
        .from('scheduled_posts')
        .select('scheduled_for, post_count')
        .eq('model_id', model.model_number)
        .gte('scheduled_for', new Date().toISOString().slice(0, 10))
        .lte('scheduled_for', horizonEnd)
      for (const row of (fcRows ?? []) as Array<{ scheduled_for: string; post_count: number }>) {
        if (row.post_count > 1) report.duplicateSlots.push(row.scheduled_for)
        else if (!isFixedSlotTime(row.scheduled_for)) report.offSlots.push(row.scheduled_for)
      }
    }

    if (moveExtras && report.duplicateSlots.length > 0) {
      const { data: dupRows } = await supabaseAdmin
        .from('scheduled_posts')
        .select('scheduled_for, post_count')
        .eq('model_id', model.model_number!)
        .in('scheduled_for', report.duplicateSlots)
      await moveExtrasForModel(
        model,
        ((dupRows ?? []) as Array<{ scheduled_for: string; post_count: number }>)
          .map(r => ({ iso: r.scheduled_for, count: r.post_count })),
        budget,
        report,
      )
    }

    reports.push(report)
  }

  // ── Summary ──
  const total = (fn: (r: AuditModelReport) => number) => reports.reduce((s, r) => s + fn(r), 0)
  const anomalies = reports.filter(r =>
    r.refillShort > 0 || r.duplicateSlots.length > 0 || r.offSlots.length > 0 || r.moveFailures > 0)

  const lines = [
    `🧮 <b>FanslyTrends scheduler audit</b> (${days}d horizon${refill ? '' : ' · DRY RUN'}${moveExtras ? ' · mover ON' : ''})`,
    ``,
    `📉 Deficit slots found: ${total(r => r.deficits)}`,
    `🆕 Refilled with new ideas: ${total(r => r.refilled)} · ♻️ re-queued: ${total(r => r.requeued)}`,
    ...(total(r => r.refillShort) > 0 ? [`⚠️ Unfillable (no eligible ideas): ${total(r => r.refillShort)}`] : []),
    `👯 Duplicate-stacked slots: ${total(r => r.duplicateSlots.length)} · 🔀 moved: ${total(r => r.moved)}`,
    ...(total(r => r.moveFailures) > 0 ? [`❌ Move failures: ${total(r => r.moveFailures)}`] : []),
    ...(total(r => r.missedToday) > 0 ? [`⌛ Today-slots past the 45-min buffer: ${total(r => r.missedToday)}`] : []),
  ]
  for (const r of anomalies.slice(0, 15)) {
    const bits = [
      r.refillShort > 0 ? `${r.refillShort} unfillable` : '',
      r.duplicateSlots.length > 0 ? `${r.duplicateSlots.length} dup slots` : '',
      r.offSlots.length > 0 ? `${r.offSlots.length} off-slot` : '',
      r.moveFailures > 0 ? `${r.moveFailures} move-fails` : '',
    ].filter(Boolean).join(', ')
    lines.push(`• @${r.handle}: ${bits}`)
  }
  const summary = lines.join('\n')
  console.log(`[audit] ${summary.replace(/<[^>]+>/g, '')}`)
  await sendTelegram(summary).catch(() => {})

  // Persist the last report for quick inspection
  try { fs.writeFileSync('/tmp/last-audit.json', JSON.stringify(reports, null, 2)) } catch { /* ignore */ }
  return summary
}
