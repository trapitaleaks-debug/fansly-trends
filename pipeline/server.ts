/**
 * Phase 8 — Railway always-on service
 * Express server + node-cron + Telegram webhook
 */

import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import express from 'express'
import cron from 'node-cron'
import { runPipelineForModel, processApprovedRuns } from './index'
import { checkAutoApprove } from './telegram-bot'
import { handleTelegramCommand } from './telegram-bot'
import { getActiveModels } from './db'

const app = express()
app.use(express.json())

const PORT = parseInt(process.env.PORT ?? '3001', 10)
const CYCLE_DAYS = parseInt(process.env.PIPELINE_CYCLE_DAYS ?? '3', 10)

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', cycle_days: CYCLE_DAYS, uptime: process.uptime() })
})

// ─── Telegram webhook ─────────────────────────────────────────────────────────

app.post('/webhook/telegram', async (req, res) => {
  res.sendStatus(200) // Respond immediately

  try {
    const update = req.body
    const message = update?.message ?? update?.channel_post
    if (!message?.text) return

    const chatId = String(message.chat?.id)
    const managerChatId = process.env.TELEGRAM_MANAGER_CHAT_ID
    if (managerChatId && chatId !== managerChatId) return // Ignore other chats

    console.log(`[webhook] Received: "${message.text}"`)
    await handleTelegramCommand(message.text)

    // After approve command, check if any runs are now approved and post them
    if (message.text.trim().toLowerCase() === 'approve') {
      setTimeout(() => processApprovedRuns().catch(console.error), 1000)
    }
  } catch (e) {
    console.error('[webhook] Error:', (e as Error).message)
  }
})

// ─── Crons ────────────────────────────────────────────────────────────────────

// Hourly: check auto-approve + process approved runs
cron.schedule('0 * * * *', async () => {
  console.log('[cron] Hourly check...')
  try {
    await checkAutoApprove()
    await processApprovedRuns()
  } catch (e) {
    console.error('[cron] Hourly error:', (e as Error).message)
  }
})

// Every 3 days at 3am UTC: trigger pipeline for each active model
const cycleHour = 3
const cycleCron = `0 ${cycleHour} */${CYCLE_DAYS} * *`
cron.schedule(cycleCron, async () => {
  console.log(`[cron] Pipeline cycle starting...`)
  try {
    const models = await getActiveModels()
    console.log(`[cron] ${models.length} active models`)
    for (const model of models) {
      try {
        await runPipelineForModel(model.handle)
      } catch (e) {
        console.error(`[cron] Pipeline failed for @${model.handle}:`, (e as Error).message)
      }
    }
  } catch (e) {
    console.error('[cron] Cycle error:', (e as Error).message)
  }
})

// ─── Register Telegram webhook on startup ─────────────────────────────────────

async function registerWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const serviceUrl = process.env.RAILWAY_STATIC_URL ?? process.env.SERVICE_URL
  if (!token || !serviceUrl) {
    console.log('[webhook] TELEGRAM_BOT_TOKEN or SERVICE_URL not set, skipping webhook registration')
    return
  }
  const webhookUrl = `${serviceUrl}/webhook/telegram`
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl }),
  })
  const json = await res.json() as { ok: boolean; description?: string }
  if (json.ok) {
    console.log(`[webhook] Registered: ${webhookUrl}`)
  } else {
    console.error('[webhook] Registration failed:', json.description)
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n🚀 Pipeline server running on port ${PORT}`)
  console.log(`   Cycle: every ${CYCLE_DAYS} days at ${cycleHour}:00 UTC`)
  console.log(`   Cron: ${cycleCron}`)
  await registerWebhook()
})

export default app
