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
import { getNextSlot } from '../lib/scheduling'

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

// ─── Fill-gaps: create video_jobs for matched ideas that never got one ────────

app.post('/jobs/fill-gaps', (_req, res) => {
  res.json({ message: 'fill-gaps started — follow Railway logs' })

  ;(async () => {
    try {
      const { data: models } = await supabaseAdmin
        .from('trends_models')
        .select('id, fansly_username, niches, placeholder_options')
        .not('niches', 'is', null)
        .neq('niches', '{}')
        .order('model_number')

      if (!models?.length) { console.log('[fill-gaps] No models'); return }

      let totalCreated = 0

      for (const model of models) {
        // Collect content bank tags for this model's footage
        const { data: pipelineModel } = await supabaseAdmin
          .from('pipeline_models')
          .select('id')
          .ilike('handle', model.fansly_username)
          .maybeSingle()

        type FootageRow = { id: string; r2_key: string; label: string | null; trim_end: number | null; tags: string[] }
        type ClipRow = { id: string; r2_key: string }
        let footage: FootageRow[] = []
        let existingClips: ClipRow[] = []
        const contentBankTags = new Set<string>()

        if (pipelineModel) {
          const [{ data: bank }, { data: clips }] = await Promise.all([
            supabaseAdmin.from('pipeline_content_bank').select('id, r2_key, label, trim_end, tags').eq('model_id', pipelineModel.id).order('created_at'),
            supabaseAdmin.from('model_clips').select('id, r2_key').eq('model_id', model.id),
          ])
          footage = (bank ?? []) as FootageRow[]
          existingClips = (clips ?? []) as ClipRow[]
          for (const item of footage) {
            for (const t of (item.tags ?? [])) contentBankTags.add(t)
          }
        }

        if (footage.length === 0) {
          console.log(`[fill-gaps] @${model.fansly_username}: no footage — skipping`)
          continue
        }

        // Count existing jobs for rotation index
        const { count: totalJobCount } = await supabaseAdmin
          .from('video_jobs')
          .select('id', { count: 'exact', head: true })
          .eq('model_id', model.id)
        let rotationOffset = totalJobCount ?? 0

        // Load matched ideas
        const { data: ideas } = await supabaseAdmin
          .from('trends_ideas')
          .select('id, niches, tags, trends_posts(id, text_template, video_jobs(id, status, model_id, output_r2_key))')
          .overlaps('niches', model.niches)
          .order('created_at', { ascending: false })

        if (!ideas) continue

        const r2KeyToClipId = new Map(existingClips.map(c => [c.r2_key, c.id]))
        let modelCreated = 0

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const rawIdea of (ideas as any[])) {
          const idea = rawIdea as { id: string; niches: string[]; tags: string[]; trends_posts: { id: string; text_template: string | null; video_jobs: Array<{ id: string; status: string; model_id: string; output_r2_key: string | null }> } | null }
          const post = idea.trends_posts
          if (!post?.text_template) continue

          // Content bank tag filter (mirrors matched-ideas route)
          if (contentBankTags.size > 0) {
            const ideaTags = idea.tags ?? []
            if (ideaTags.length > 0 && !ideaTags.some(t => contentBankTags.has(t))) continue
          }

          const jobs = post.video_jobs ?? []
          const hasActive = jobs.some(j =>
            j.model_id === model.id &&
            ['done', 'approved', 'posting', 'posted'].includes(j.status) &&
            j.output_r2_key
          )
          const hasInFlight = jobs.some(j =>
            j.model_id === model.id &&
            ['pending', 'processing'].includes(j.status)
          )
          if (hasActive || hasInFlight) continue

          // Footage rotation
          let clipId: string | null = null
          let clipIndex: number | null = null
          if (footage.length > 0) {
            const idx = rotationOffset % footage.length
            const chosen = footage[idx]
            clipIndex = idx + 1
            rotationOffset++

            const existingClipId = r2KeyToClipId.get(chosen.r2_key)
            if (existingClipId) {
              clipId = existingClipId
            } else {
              const { data: newClip } = await supabaseAdmin
                .from('model_clips')
                .insert({ model_id: model.id, r2_key: chosen.r2_key, filename: chosen.label ?? chosen.r2_key.split('/').pop(), duration_seconds: chosen.trim_end ?? null, tags: chosen.tags ?? [] })
                .select('id').single()
              if (newClip) {
                clipId = newClip.id
                r2KeyToClipId.set(chosen.r2_key, newClip.id)
                existingClips.push({ id: newClip.id, r2_key: chosen.r2_key })
              }
            }
          }

          const options: string[] = (model as unknown as { placeholder_options: string[] }).placeholder_options ?? []
          const placeholder = options.length > 0 ? options[Math.floor(Math.random() * options.length)] : ''
          const personalizedText = post.text_template.replace(/\[placeholder\]/gi, placeholder)
          const scheduledFor = await getNextSlot(model.id)

          const { error } = await supabaseAdmin.from('video_jobs').insert({
            post_id: post.id,
            model_id: model.id,
            clip_id: clipId,
            clip_index: clipIndex,
            duration_seconds: 5,
            original_template: post.text_template,
            personalized_text: personalizedText,
            status: 'pending',
            scheduled_for: scheduledFor.toISOString(),
          })

          if (error) {
            console.error(`[fill-gaps] Insert error @${model.fansly_username} post ${post.id}:`, error.message)
          } else {
            modelCreated++
            totalCreated++
          }
        }

        console.log(`[fill-gaps] @${model.fansly_username}: +${modelCreated} jobs created`)
      }

      console.log(`[fill-gaps] Complete — ${totalCreated} total new jobs created`)
    } catch (e) {
      console.error('[fill-gaps] Fatal error:', (e as Error).message)
    }
  })()
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

    console.log(`[cron:jobs] Processing ${jobs.length} job(s) in parallel`)
    await Promise.all(
      jobs.map(job =>
        processVideoJob(job.id).catch(e =>
          console.error(`[cron:jobs] Failed ${job.id}:`, (e as Error).message)
        )
      )
    )
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
      .lt('post_fail_count', 3)
      .order('created_at', { ascending: true })
      .limit(5)

    if (!jobs || jobs.length === 0) return

    console.log(`[cron:post] Posting ${jobs.length} job(s) in parallel`)
    await Promise.allSettled(
      jobs.map(job =>
        Promise.race([
          postVideoJob(job.id),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('postVideoJob timeout after 5min')), 5 * 60 * 1000)
          ),
        ]).catch(async e => {
          console.error(`[cron:post] Failed ${job.id}:`, (e as Error).message)
          await supabaseAdmin.from('video_jobs')
            .update({ status: 'approved' })
            .eq('id', job.id)
            .eq('status', 'posting')
            .then(() => console.log(`[cron:post] Reset ${job.id} to approved after timeout`), () => {})
        })
      )
    )
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
  const killTimer = setTimeout(() => {
    if (!child.killed) {
      console.warn('[cron:crm-scrape] Timeout (8 min) — killing stuck process')
      child.kill('SIGKILL')
      crmScraperRunning = false
    }
  }, 8 * 60 * 1000)
  child.on('exit', (code) => {
    clearTimeout(killTimer)
    crmScraperRunning = false
    console.log(`[cron:crm-scrape] Exited with code ${code}`)
  })
  child.on('error', (err) => {
    clearTimeout(killTimer)
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

app.listen(PORT, async () => {
  console.log(`\nPipeline server running on port ${PORT}`)
  console.log(`   Cycle: every ${CYCLE_DAYS} days at ${cycleHour}:00 UTC`)
  console.log(`   Cron: ${cycleCron}`)

  // Reset any jobs left in transient states from a previous process that died mid-run.
  // "processing" → pending (so render cron picks them up again)
  // "posting"    → approved (so post cron picks them up again)
  const { data: orphans } = await supabaseAdmin
    .from('video_jobs')
    .select('id, status')
    .in('status', ['processing', 'posting'])
  if (orphans && orphans.length > 0) {
    const processing = orphans.filter((j: { status: string }) => j.status === 'processing').map((j: { id: string }) => j.id)
    const posting    = orphans.filter((j: { status: string }) => j.status === 'posting').map((j: { id: string }) => j.id)
    if (processing.length > 0) {
      await supabaseAdmin.from('video_jobs').update({ status: 'pending' }).in('id', processing)
      console.log(`   Startup: reset ${processing.length} orphaned processing → pending`)
    }
    if (posting.length > 0) {
      await supabaseAdmin.from('video_jobs').update({ status: 'approved' }).in('id', posting)
      console.log(`   Startup: reset ${posting.length} orphaned posting → approved`)
    }
  }
})

export default app
