/**
 * Phase 8 — Railway always-on service
 * Express server + node-cron
 */

import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import express from 'express'
import cron from 'node-cron'
import { runPipelineForModel } from './index'
import { getActiveModels, getModel } from './db'
import { processRun } from './process'
import { supabaseAdmin } from '../lib/supabase'

const app = express()
app.use(express.json())

const PORT = parseInt(process.env.PORT ?? '3001', 10)
const CYCLE_DAYS = parseInt(process.env.PIPELINE_CYCLE_DAYS ?? '3', 10)

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', cycle_days: CYCLE_DAYS, uptime: process.uptime() })
})

// ─── Trigger endpoint: fire pipeline for a specific model ─────────────────────

app.post('/trigger/:handle', async (req, res) => {
  const { handle } = req.params
  res.status(202).json({ message: 'Pipeline started', handle })

  // Fire and forget
  runPipelineForModel(handle).catch(e =>
    console.error(`[trigger] Failed for @${handle}:`, e.message)
  )
})

// ─── Reprocess endpoint: re-run ffmpeg for a specific video ──────────────────

app.post('/reprocess/:videoId', async (req, res) => {
  const { videoId } = req.params
  const { overlay_text } = req.body ?? {}
  res.status(202).json({ message: 'Reprocess started', videoId })

  // Background
  ;(async () => {
    try {
      const { data: video } = await supabaseAdmin
        .from('pipeline_videos')
        .select('*, pipeline_runs!inner(model_id, pipeline_models!inner(handle))')
        .eq('id', videoId)
        .single()

      if (!video) throw new Error('Video not found')

      if (overlay_text) {
        const updatedBrief = { ...video.brief, overlay_text }
        await supabaseAdmin
          .from('pipeline_videos')
          .update({ brief: updatedBrief })
          .eq('id', videoId)
        video.brief = updatedBrief
      }

      const handle = video.pipeline_runs.pipeline_models.handle
      const model = await getModel(handle)
      if (!model) throw new Error('Model not found')

      // Reset status to pending so processRun picks this video up
      await supabaseAdmin
        .from('pipeline_videos')
        .update({ status: 'pending' })
        .eq('id', videoId)

      await processRun(video.run_id, handle, model)
    } catch (e) {
      console.error(`[reprocess] Failed for ${videoId}:`, (e as Error).message)
    }
  })()
})

// ─── Crons ────────────────────────────────────────────────────────────────────

// Every N days at 3am UTC: trigger pipeline for all active models in parallel
const cycleHour = 3
const cycleCron = `0 ${cycleHour} */${CYCLE_DAYS} * *`
cron.schedule(cycleCron, async () => {
  console.log(`[cron] Pipeline cycle starting...`)
  try {
    const models = await getActiveModels()
    console.log(`[cron] ${models.length} active models — running in parallel`)
    await Promise.all(
      models.map(m =>
        runPipelineForModel(m.handle).catch(e =>
          console.error(`[cron] Pipeline failed for @${m.handle}:`, e.message)
        )
      )
    )
    console.log(`[cron] Pipeline cycle complete`)
  } catch (e) {
    console.error('[cron] Cycle error:', (e as Error).message)
  }
})

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nPipeline server running on port ${PORT}`)
  console.log(`   Cycle: every ${CYCLE_DAYS} days at ${cycleHour}:00 UTC`)
  console.log(`   Cron: ${cycleCron}`)
})

export default app
