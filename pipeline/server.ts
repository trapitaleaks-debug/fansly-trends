/**
 * Phase 8 — Railway always-on service
 * Express server + node-cron
 * restart-trigger: 2026-06-24
 */

import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import express from 'express'
import cron from 'node-cron'
import { runPipelineForModel } from './index'
import { getActiveModels, getModel } from './db'
import { processRun } from './process'
import { generateBriefs } from './research'
import { generateSlot } from './generate'
import { processVideoJob } from './process-job'
import { postVideoJob } from './post-video-job'
import { supabaseAdmin } from '../lib/supabase'

const app = express()
app.use(express.json())

const PORT = parseInt(process.env.PORT ?? '3001', 10)
const CYCLE_DAYS = parseInt(process.env.PIPELINE_CYCLE_DAYS ?? '3', 10)

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', cycle_days: CYCLE_DAYS, uptime: process.uptime() })
})

// ─── Emoji pipeline diagnostics ───────────────────────────────────────────────

app.get('/debug/emoji', async (_req, res) => {
  const testText = "SORRY, I'M CUMMING 😔"

  // Step 1: extract emoji from text
  const re = /\p{Extended_Pictographic}(?:️?(?:‍\p{Extended_Pictographic}️?)*)?️?/gu
  const found: string[] = []
  for (const m of testText.matchAll(re)) { if (m[0].trim()) found.push(m[0]) }

  const result: Record<string, unknown> = { text: testText, extracted: found, step: 'extraction' }

  if (found.length === 0) {
    result.verdict = 'FAIL: extractEmoji found nothing'
    return res.json(result)
  }

  // Step 2: download to temp file
  const emoji = found[0]
  const cps = [...emoji].map(c => c.codePointAt(0)!).filter(cp => cp !== 0xFE0F)
  const cp = cps.map(cp => cp.toString(16)).join('_')
  const url = `https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/png/72/emoji_u${cp}.png`
  result.cp = cp
  result.url = url
  result.step = 'download'

  try {
    const fetchRes = await fetch(url, { signal: AbortSignal.timeout(10000) })
    result.httpStatus = fetchRes.status
    if (!fetchRes.ok) {
      result.verdict = `FAIL: HTTP ${fetchRes.status}`
      return res.json(result)
    }
    const buf = Buffer.from(await fetchRes.arrayBuffer())
    result.fetchedBytes = buf.length
    result.step = 'write'

    const tmpFile = path.join(os.tmpdir(), `emoji_debug_${Date.now()}.png`)
    fs.writeFileSync(tmpFile, buf)
    const writtenSize = fs.statSync(tmpFile).size
    fs.unlinkSync(tmpFile)
    result.writtenBytes = writtenSize
    result.verdict = writtenSize > 200 ? 'OK: all steps passed' : `FAIL: written file too small (${writtenSize}B)`
  } catch (e) {
    result.error = (e as Error).message
    result.verdict = `FAIL: exception — ${(e as Error).message}`
  }

  res.json(result)
})

// ─── Manual video job trigger ─────────────────────────────────────────────────

// ─── Manual scrape trigger ────────────────────────────────────────────────────

app.post('/scrape', (_req, res) => {
  if (scraperRunning) {
    res.json({ message: 'Scraper already running' })
    return
  }
  scraperRunning = true
  res.json({ message: 'Scrape started' })
  console.log('[scrape] Manual trigger — starting FYP scrape...')
  const child = spawn(
    'npx', ['ts-node', '--project', 'scraper/tsconfig.json', 'scraper/index.ts'],
    { cwd: path.resolve(__dirname, '..'), env: process.env, stdio: 'inherit' }
  )
  child.on('exit', (code) => {
    scraperRunning = false
    console.log(`[scrape] Exited with code ${code}`)
  })
  child.on('error', (err) => {
    scraperRunning = false
    console.error('[scrape] Spawn error:', err.message)
  })
})

app.post('/jobs/process', async (_req, res) => {
  const { data: jobs } = await supabaseAdmin
    .from('video_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(5)

  const ids = (jobs ?? []).map((j: { id: string }) => j.id)
  res.json({ message: 'Processing started', jobs: ids })

  for (const id of ids) {
    processVideoJob(id).catch(e => console.error(`[jobs/process] Failed ${id}:`, (e as Error).message))
  }
})

app.post('/jobs/process/:jobId', async (req, res) => {
  const { jobId } = req.params
  res.json({ message: 'Processing started', jobId })
  processVideoJob(jobId).catch(e => console.error(`[jobs/process] Failed ${jobId}:`, (e as Error).message))
})

// Retry posting a specific job that already rendered (status=done, output_r2_key set)
app.post('/jobs/post/:jobId', async (req, res) => {
  const { jobId } = req.params
  res.json({ message: 'Posting started', jobId })
  postVideoJob(jobId).catch(e => console.error(`[jobs/post] Failed ${jobId}:`, (e as Error).message))
})

// ─── Trigger endpoint: fire pipeline for a specific model ─────────────────────

app.post('/trigger/:handle', async (req, res) => {
  const { handle } = req.params
  const { runId } = (req.body ?? {}) as { runId?: string }
  res.status(202).json({ message: 'Pipeline started', handle })

  runPipelineForModel(handle, runId).catch(e =>
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

// ─── Regenerate endpoint: re-generate brief + video for a single slot (with user feedback) ──

app.post('/regenerate/:videoId', async (req, res) => {
  const { videoId } = req.params
  const { feedback } = (req.body ?? {}) as { feedback?: string }
  res.status(202).json({ message: 'Regeneration started', videoId })

  ;(async () => {
    try {
      const { data: video } = await supabaseAdmin
        .from('pipeline_videos')
        .select('*, pipeline_runs!inner(model_id, pipeline_models!inner(handle))')
        .eq('id', videoId)
        .single()

      if (!video) throw new Error('Video not found')

      const handle = (video as unknown as { pipeline_runs: { pipeline_models: { handle: string } } }).pipeline_runs.pipeline_models.handle
      const model = await getModel(handle)
      if (!model) throw new Error('Model not found')

      console.log(`[regenerate] Re-generating slot ${video.slot} for @${handle} with feedback: "${feedback ?? 'none'}"`)

      // Mark as generating so UI shows progress
      await supabaseAdmin.from('pipeline_videos').update({ status: 'generating' }).eq('id', videoId)

      // Inject feedback into the model's notes temporarily for this generation
      const augmentedModel = feedback
        ? { ...model, notes_for_ai: `${model.notes_for_ai ?? ''}\n\n## USER FEEDBACK ON PREVIOUS VERSION (slot ${video.slot})\n${feedback}\n\nFix the issues mentioned above. Do not repeat the same mistakes.` }
        : model

      // Re-generate briefs and pick the one for this slot
      const briefs = await generateBriefs(augmentedModel)
      const newBrief = briefs[video.slot - 1] ?? briefs[0]

      // Preserve feedback history
      const prevBrief = video.brief as Record<string, unknown> | null
      const rawHistory = (prevBrief?.feedback_history as Array<{ feedback: string; at: string }>) ?? []
      if (feedback) rawHistory.push({ feedback, at: new Date().toISOString() })
      const updatedBrief = { ...newBrief, feedback_history: rawHistory }

      // Save new brief, reset status
      await supabaseAdmin.from('pipeline_videos').update({
        brief: updatedBrief,
        status: 'queued',
        final_r2_key: null,
        thumbnail_r2_key: null,
      }).eq('id', videoId)

      // Re-generate visual
      await generateSlot(videoId, updatedBrief, handle, model)

      // Re-process with ffmpeg
      const { data: refreshed } = await supabaseAdmin
        .from('pipeline_videos')
        .select('*')
        .eq('id', videoId)
        .single()

      if (refreshed?.status === 'pending' && refreshed.final_r2_key) {
        await processRun(video.run_id, handle, model)
      }

      console.log(`[regenerate] ✓ Slot ${video.slot} regenerated`)
    } catch (e) {
      console.error(`[regenerate] Failed for ${videoId}:`, (e as Error).message)
      await supabaseAdmin.from('pipeline_videos').update({ status: 'rejected' }).eq('id', videoId)
    }
  })()
})

// ─── Crons ────────────────────────────────────────────────────────────────────

// Every minute: process pending video_jobs (own footage + text overlay)
let jobsRunning = false
cron.schedule('* * * * *', async () => {
  if (jobsRunning) return
  jobsRunning = true
  try {
    const { data: jobs } = await supabaseAdmin
      .from('video_jobs')
      .select('id')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(2)

    if (!jobs || jobs.length === 0) return

    for (const job of jobs) {
      console.log(`[cron:jobs] Processing job ${job.id}`)
      await processVideoJob(job.id).catch(e =>
        console.error(`[cron:jobs] Failed ${job.id}:`, (e as Error).message)
      )
    }
  } catch (e) {
    console.error('[cron:jobs] Error:', (e as Error).message)
  } finally {
    jobsRunning = false
  }
})

// Every minute: auto-approve all done video_jobs (skip manual review step)
cron.schedule('* * * * *', async () => {
  try {
    await supabaseAdmin
      .from('video_jobs')
      .update({ status: 'approved' })
      .eq('status', 'done')
  } catch (e) {
    console.error('[cron:auto-approve] Error:', (e as Error).message)
  }
})

// Every minute: post one approved video_job to FanCore (sequential — one Playwright at a time)
let postingRunning = false
cron.schedule('* * * * *', async () => {
  if (postingRunning) return
  postingRunning = true
  try {
    const { data: jobs } = await supabaseAdmin
      .from('video_jobs')
      .select('id')
      .eq('status', 'approved')
      .lt('post_fail_count', 3)  // skip permanently-failed jobs (post-video-job.ts sets error after 3)
      .order('created_at', { ascending: true })
      .limit(1)

    if (!jobs || jobs.length === 0) return

    const job = jobs[0]
    console.log(`[cron:post] Posting job ${job.id}`)
    await Promise.race([
      postVideoJob(job.id),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('postVideoJob timeout after 5min')), 5 * 60 * 1000)
      ),
    ]).catch(async e => {
      console.error(`[cron:post] Failed ${job.id}:`, (e as Error).message)
      // Only reset if postVideoJob didn't already update the status (e.g. the 5-min timeout fired
      // while postVideoJob was still mid-run and hadn't caught the error yet)
      await supabaseAdmin.from('video_jobs')
        .update({ status: 'approved' })
        .eq('id', job.id)
        .eq('status', 'posting')
        .then(() => console.log(`[cron:post] Reset ${job.id} to approved after timeout`), () => {})
    })
  } catch (e) {
    console.error('[cron:post] Error:', (e as Error).message)
  } finally {
    postingRunning = false
  }
})

// Every 2 min: pick up any queued runs dropped by a restart/deploy
cron.schedule('*/2 * * * *', async () => {
  try {
    const { data: queuedRuns } = await supabaseAdmin
      .from('pipeline_runs')
      .select('id, pipeline_models!inner(handle)')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(3)

    if (!queuedRuns || queuedRuns.length === 0) return

    for (const run of queuedRuns) {
      const handle = (run as unknown as { id: string; pipeline_models: { handle: string } }).pipeline_models.handle
      console.log(`[cron:queued] Picking up dropped run ${run.id} for @${handle}`)
      runPipelineForModel(handle, run.id).catch(e =>
        console.error(`[cron:queued] Failed for ${run.id}:`, e.message)
      )
    }
  } catch (e) {
    console.error('[cron:queued] Error:', (e as Error).message)
  }
})

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

// ─── FYP Scraper cron (hourly — replaces GitHub Actions) ─────────────────────
// The scraper calls process.exit() so it must run as a child process, not imported.
let scraperRunning = false
cron.schedule('0 * * * *', () => {
  if (scraperRunning) {
    console.log('[cron:scrape] Skipping — previous run still active')
    return
  }
  scraperRunning = true
  console.log('[cron:scrape] Starting FYP scrape...')
  const child = spawn(
    'npx', ['ts-node', '--project', 'scraper/tsconfig.json', 'scraper/index.ts'],
    { cwd: path.resolve(__dirname, '..'), env: process.env, stdio: 'inherit' }
  )
  child.on('exit', (code) => {
    scraperRunning = false
    console.log(`[cron:scrape] Exited with code ${code}`)
  })
  child.on('error', (err) => {
    scraperRunning = false
    console.error('[cron:scrape] Spawn error:', err.message)
  })
})

// ─── FanCore CRM scraper cron (hourly — keeps scheduled_posts in sync) ──────
let crmScraperRunning = false
cron.schedule('0 * * * *', () => {
  if (crmScraperRunning) {
    console.log('[cron:crm-scrape] Skipping — previous run still active')
    return
  }
  crmScraperRunning = true
  console.log('[cron:crm-scrape] Starting FanCore scheduled_posts sync...')
  const child = spawn(
    'npx', ['ts-node', '--project', 'pipeline/tsconfig.json', 'pipeline/seed-scheduled-posts.ts'],
    { cwd: path.resolve(__dirname, '..'), env: process.env, stdio: 'inherit' }
  )
  child.on('exit', (code) => {
    crmScraperRunning = false
    console.log(`[cron:crm-scrape] Exited with code ${code}`)
  })
  child.on('error', (err) => {
    crmScraperRunning = false
    console.error('[cron:crm-scrape] Spawn error:', err.message)
  })
})

// ─── Velocity check cron (2am UTC daily — replaces GitHub Actions) ────────────
cron.schedule('0 2 * * *', () => {
  console.log('[cron:velocity] Starting velocity check...')
  const child = spawn(
    'npx', ['ts-node', '--project', 'scraper/tsconfig.json', 'scraper/velocity.ts'],
    { cwd: path.resolve(__dirname, '..'), env: process.env, stdio: 'inherit' }
  )
  child.on('exit', (code) => console.log(`[cron:velocity] Exited with code ${code}`))
  child.on('error', (err) => console.error('[cron:velocity] Spawn error:', err.message))
})

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nPipeline server running on port ${PORT}`)
  console.log(`   Cycle: every ${CYCLE_DAYS} days at ${cycleHour}:00 UTC`)
  console.log(`   Cron: ${cycleCron}`)
})

export default app
