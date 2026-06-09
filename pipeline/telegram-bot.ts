/**
 * Phase 5 — Telegram Approval Bot
 * Sends batch previews, handles approve/skip/reject/replace commands.
 * Also runs auto-approve cron: any run pending >4h gets auto-approved.
 */

import { getSignedVideoUrl } from '../lib/r2'
import { supabaseAdmin } from '../lib/supabase'
import {
  getRunVideos, updateVideo, updateRunStatus, getRun,
  type PipelineRun, type PipelineVideo
} from './db'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!
const CHAT_ID = process.env.TELEGRAM_MANAGER_CHAT_ID!
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`

// ─── Send helpers ─────────────────────────────────────────────────────────────

async function tgPost(method: string, body: object): Promise<unknown> {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

export async function sendApprovalBatch(run: PipelineRun, handle: string): Promise<void> {
  const videos = await getRunVideos(run.id)
  const active = videos.filter(v => v.status === 'pending')

  if (active.length === 0) {
    await tgPost('sendMessage', {
      chat_id: CHAT_ID,
      text: `⚠️ Run ${run.id.slice(0, 8)} for @${handle} has no pending videos.`,
    })
    return
  }

  // Send header message
  const cycleNum = await getCycleNumber(run.model_id)
  await tgPost('sendMessage', {
    chat_id: CHAT_ID,
    parse_mode: 'HTML',
    text: `🎬 <b>Batch ready — @${handle} (Cycle #${cycleNum})</b>\n\nRun ID: <code>${run.id.slice(0, 8)}</code>\n${active.length} videos ready for review.\nAuto-approve in <b>4 hours</b> if no response.\n\n<b>Commands:</b>\n<code>approve</code> — post all\n<code>skip N</code> — remove slot N\n<code>reject N</code> — see alternatives for slot N\n<code>replace N</code> — regenerate slot N`,
  })

  // Send each video thumbnail + brief
  for (const video of active) {
    try {
      const thumbUrl = video.thumbnail_r2_key
        ? await getSignedVideoUrl(video.thumbnail_r2_key, 3600)
        : null
      const finalUrl = video.final_r2_key
        ? await getSignedVideoUrl(video.final_r2_key, 3600)
        : null

      const brief = video.brief
      const formatLabel = brief?.content_format
        ? brief.content_format.replace('_', ' ').toUpperCase()
        : brief?.overlay_formula?.replace('_', ' ').toUpperCase() ?? '?'

      const scores = brief?.quality_scores
      const scoreBar = scores
        ? `📊 AI ${scores.ai_quality}/10 · Total ${scores.total}/90` +
          (scores.notes ? ` · ${scores.notes}` : '')
        : ''

      const caption = [
        `<b>Slot ${video.slot}</b> — ${formatLabel}`,
        `🎯 <b>${brief?.overlay_text}</b>`,
        brief?.hook_description ? `🪝 ${brief.hook_description}` : '',
        brief?.payoff_description ? `💥 ${brief.payoff_description}` : '',
        scoreBar,
        finalUrl ? `\n🎬 <a href="${finalUrl}">Watch video</a>` : '',
      ].filter(Boolean).join('\n')

      if (thumbUrl) {
        await tgPost('sendPhoto', {
          chat_id: CHAT_ID,
          photo: thumbUrl,
          caption,
          parse_mode: 'HTML',
        })
      } else {
        await tgPost('sendMessage', { chat_id: CHAT_ID, text: caption, parse_mode: 'HTML' })
      }
    } catch (e) {
      console.error(`  ⚠ Could not send slot ${video.slot} preview:`, (e as Error).message)
    }
  }
}

async function getCycleNumber(modelId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from('pipeline_runs')
    .select('*', { count: 'exact', head: true })
    .eq('model_id', modelId)
  return (count ?? 0)
}

// ─── Command handler ──────────────────────────────────────────────────────────

export async function handleTelegramCommand(text: string): Promise<void> {
  const cmd = text.trim().toLowerCase()

  if (cmd === 'approve') {
    await approveLatestRun()
    return
  }

  const skipMatch = cmd.match(/^skip\s+(\d+)$/)
  if (skipMatch) {
    await skipSlot(parseInt(skipMatch[1]))
    return
  }

  const rejectMatch = cmd.match(/^reject\s+(\d+)$/)
  if (rejectMatch) {
    await rejectSlot(parseInt(rejectMatch[1]))
    return
  }

  const pickMatch = cmd.match(/^pick\s+(\d+)([abc])$/)
  if (pickMatch) {
    await pickVariant(parseInt(pickMatch[1]), pickMatch[2])
    return
  }

  const replaceMatch = cmd.match(/^replace\s+(\d+)$/)
  if (replaceMatch) {
    await tgPost('sendMessage', {
      chat_id: CHAT_ID,
      text: `♻️ Replace for slot ${replaceMatch[1]} noted. Full regeneration not yet implemented — use <code>skip ${replaceMatch[1]}</code> to remove this slot and approve the rest.`,
      parse_mode: 'HTML',
    })
    return
  }
}

async function getLatestPendingRun(): Promise<PipelineRun | null> {
  const { data } = await supabaseAdmin
    .from('pipeline_runs')
    .select('*')
    .eq('status', 'pending_approval')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
  return data ?? null
}

async function approveLatestRun(): Promise<void> {
  const run = await getLatestPendingRun()
  if (!run) {
    await tgPost('sendMessage', { chat_id: CHAT_ID, text: '⚠️ No pending run found.' })
    return
  }
  await updateRunStatus(run.id, 'approved')
  await tgPost('sendMessage', {
    chat_id: CHAT_ID,
    text: `✅ Run <code>${run.id.slice(0, 8)}</code> approved! Starting FanCore posting...`,
    parse_mode: 'HTML',
  })
}

async function skipSlot(slot: number): Promise<void> {
  const run = await getLatestPendingRun()
  if (!run) return

  const videos = await getRunVideos(run.id)
  const target = videos.find(v => v.slot === slot && v.status === 'pending')
  if (!target) {
    await tgPost('sendMessage', { chat_id: CHAT_ID, text: `⚠️ Slot ${slot} not found or already processed.` })
    return
  }

  await updateVideo(target.id, { status: 'skipped' })

  const remaining = videos.filter(v => v.slot !== slot && v.status === 'pending')
  if (remaining.length === 0) {
    await tgPost('sendMessage', {
      chat_id: CHAT_ID,
      text: `⚠️ Slot ${slot} skipped. No more active videos — approve cancelled.`,
    })
    return
  }

  await tgPost('sendMessage', {
    chat_id: CHAT_ID,
    parse_mode: 'HTML',
    text: `⏭ Slot ${slot} skipped. ${remaining.length} videos remaining.\nSend <code>approve</code> to post them.`,
  })
}

async function rejectSlot(slot: number): Promise<void> {
  const run = await getLatestPendingRun()
  if (!run) return

  await tgPost('sendMessage', {
    chat_id: CHAT_ID,
    parse_mode: 'HTML',
    text: `❌ Slot ${slot} rejected.\n\nAlternative generation not yet implemented. Use <code>skip ${slot}</code> to remove this slot, or <code>approve</code> to post remaining slots.`,
  })
}

async function pickVariant(slot: number, variant: string): Promise<void> {
  await tgPost('sendMessage', {
    chat_id: CHAT_ID,
    text: `✅ Picked variant ${variant.toUpperCase()} for slot ${slot}. Full variant selection coming in V2.`,
  })
}

// ─── Auto-approve cron ────────────────────────────────────────────────────────

export async function checkAutoApprove(): Promise<void> {
  const FOUR_HOURS_AGO = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()

  const { data: stale } = await supabaseAdmin
    .from('pipeline_runs')
    .select('id, model_id')
    .eq('status', 'pending_approval')
    .lt('created_at', FOUR_HOURS_AGO)

  for (const run of stale ?? []) {
    await updateRunStatus(run.id, 'approved')
    await tgPost('sendMessage', {
      chat_id: CHAT_ID,
      parse_mode: 'HTML',
      text: `⏱ Auto-approved run <code>${run.id.slice(0, 8)}</code> after 4h timeout. Posting to FanCore now...`,
    })
    console.log(`[auto-approve] Run ${run.id.slice(0, 8)} auto-approved`)
  }
}
