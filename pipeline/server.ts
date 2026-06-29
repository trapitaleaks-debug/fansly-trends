/**
 * Phase 8 — Railway always-on service
 * Express server + node-cron
 * restart-trigger: 2026-06-24
 */

import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

// Prevent EPIPE (broken pipe from crashed child/Remotion Chrome) from killing the server
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
    console.warn('[server] Suppressed pipe error:', err.code)
    return
  }
  console.error('[server] Uncaught exception — restarting:', err.message)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason)
})

// Kill any Chrome processes left over from a previous crash/restart in the same container.
// Railway restarts the Node process without a new container, so orphaned Chrome accumulates
// and causes OOM crashes for subsequent launches.
try {
  // Also kill orphaned ffmpeg — an abandoned Remotion render leaves both chrome AND ffmpeg behind,
  // and after an OOM-kill cycle they pile up (we saw 300+ procs, only a few chrome) and re-OOM.
  execSync('pkill -9 -f chrome-headless-shell 2>/dev/null; pkill -9 -f chromium 2>/dev/null; pkill -9 -f ffmpeg 2>/dev/null; true', { stdio: 'ignore' })
  console.log('[startup] Killed orphaned Chrome/ffmpeg processes')
} catch { /* ignore — no orphans */ }

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, execSync } from 'child_process'
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
import { insertVideoJobWithSlot } from '../lib/scheduling'
import { sendTelegram } from '../lib/telegram'

const app = express()
app.use(express.json())

const PORT = parseInt(process.env.PORT ?? '3001', 10)
const CYCLE_DAYS = parseInt(process.env.PIPELINE_CYCLE_DAYS ?? '3', 10)

// ─── Health check ─────────────────────────────────────────────────────────────

// Reliable status histogram. NOTE: supabaseAdmin.from('video_jobs').select('status') silently
// caps at 1000 rows, so once 'posted' grows past ~1000 a row-fetch histogram under-counts (and
// could even compute in_flight=0 → a false "queue drained" alert). Count each status separately.
const JOB_STATUSES = ['pending', 'processing', 'done', 'approved', 'posting', 'posted', 'error'] as const

async function getStatusHistogram(): Promise<Record<string, number>> {
  const results = await Promise.all(
    JOB_STATUSES.map(async s => {
      const { count } = await supabaseAdmin
        .from('video_jobs').select('id', { count: 'exact', head: true }).eq('status', s)
      return [s, count ?? 0] as const
    })
  )
  const hist: Record<string, number> = {}
  for (const [s, c] of results) if (c > 0) hist[s] = c
  return hist
}

function countProcs(): { chrome: number; total: number } {
  try {
    const out = execSync('ps aux 2>/dev/null || true', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    const lines = out.trim().split('\n')
    return {
      total: lines.length - 1,
      chrome: lines.filter(l => l.includes('chrome-headless-shell') || l.includes('chromium')).length,
    }
  } catch {
    return { chrome: 0, total: 0 }
  }
}

app.get('/health', (_req, res) => {
  const { chrome, total } = countProcs()
  res.json({ status: 'ok', cycle_days: CYCLE_DAYS, uptime: process.uptime(), chrome_procs: chrome, total_procs: total })
})

// One-glance queue + process snapshot — check this instead of babysitting FanCore.
app.get('/stats', async (_req, res) => {
  try {
    const jobs = await getStatusHistogram()
    const inFlight = (jobs.pending ?? 0) + (jobs.processing ?? 0) + (jobs.approved ?? 0) + (jobs.posting ?? 0) + (jobs.done ?? 0)
    const { chrome, total } = countProcs()
    res.json({ status: 'ok', jobs, in_flight: inFlight, chrome_procs: chrome, total_procs: total, uptime: process.uptime() })
  } catch (e) {
    res.status(500).json({ status: 'error', error: (e as Error).message })
  }
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

let fillGapsRunning = false
app.post('/jobs/fill-gaps', (_req, res) => {
  // Single-flight: the button is fire-and-forget and re-enables immediately, so rapid presses
  // would spawn concurrent runs. Each run snapshots existing jobs at its start, so a 2nd run
  // wouldn't see the 1st's inserts → duplicate jobs. Ignore presses while a run is in progress.
  if (fillGapsRunning) {
    res.json({ message: 'fill-gaps already running — press ignored', alreadyRunning: true })
    return
  }
  fillGapsRunning = true
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

      const summary = {
        created: 0,
        requeued: 0,
        modelsNoFootage: 0,
        insertErrors: 0,
        skipped: { no_template: 0, tag_mismatch: 0, already_active: 0, in_flight: 0, dup_in_run: 0 },
      }
      // Two matched ideas can resolve to the same post; the post.video_jobs join is a stale
      // snapshot for the whole run, so we'd insert a duplicate for the 2nd. Track inserts here —
      // keyed by model:post (NOT post alone), because the same trending post is matched by many
      // models, and a post-only key made the first model claim every shared post so later models
      // generated nothing ("only the first model" bug).
      const insertedKeys = new Set<string>()

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
          summary.modelsNoFootage++
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
          if (!post?.text_template) { summary.skipped.no_template++; continue }

          // Content bank tag filter (mirrors matched-ideas route)
          if (contentBankTags.size > 0) {
            const ideaTags = idea.tags ?? []
            if (ideaTags.length > 0 && !ideaTags.some(t => contentBankTags.has(t))) {
              summary.skipped.tag_mismatch++; continue
            }
          }

          // Per-run dedup — don't insert a second job for THIS model+post in the same run.
          const dedupKey = `${model.id}:${post.id}`
          if (insertedKeys.has(dedupKey)) { summary.skipped.dup_in_run++; continue }

          const jobs = (post.video_jobs ?? []).filter(j => j.model_id === model.id)
          const hasActive = jobs.some(j =>
            ['done', 'approved', 'posting', 'posted'].includes(j.status) && j.output_r2_key
          )
          const hasInFlight = jobs.some(j => ['pending', 'processing'].includes(j.status))
          if (hasActive) { summary.skipped.already_active++; continue }
          if (hasInFlight) { summary.skipped.in_flight++; continue }

          // Re-queue an errored job in place instead of inserting a duplicate beside it. This is
          // why fill-gaps used to balloon the table on re-runs: 'error' was treated as a gap.
          const erroredJob = jobs.find(j => j.status === 'error')
          if (erroredJob) {
            const { error: reqErr } = await supabaseAdmin.from('video_jobs')
              .update({ status: 'pending', render_attempts: 0, post_fail_count: 0, started_at: null, error_message: null })
              .eq('id', erroredJob.id)
            if (reqErr) {
              console.error(`[fill-gaps] Re-queue error @${model.fansly_username} job ${erroredJob.id}:`, reqErr.message)
              summary.insertErrors++
            } else {
              summary.requeued++
              insertedKeys.add(dedupKey)
            }
            continue
          }

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

          // insertVideoJobWithSlot assigns a collision-free slot (4/day cap) and retries if it
          // loses the slot race; skipped_duplicate = this model already has an active job for the post.
          const res = await insertVideoJobWithSlot(model.id, {
            post_id: post.id,
            model_id: model.id,
            clip_id: clipId,
            clip_index: clipIndex,
            duration_seconds: 5,
            original_template: post.text_template,
            personalized_text: personalizedText,
            status: 'pending',
          })

          if (res.status === 'error') {
            console.error(`[fill-gaps] Insert error @${model.fansly_username} post ${post.id}:`, res.error)
            summary.insertErrors++
          } else if (res.status === 'skipped_duplicate') {
            summary.skipped.already_active++
          } else {
            modelCreated++
            summary.created++
            insertedKeys.add(dedupKey)
          }
        }

        console.log(`[fill-gaps] @${model.fansly_username}: +${modelCreated} jobs created`)
      }

      const s = summary
      const skippedTotal = s.skipped.no_template + s.skipped.tag_mismatch + s.skipped.already_active + s.skipped.in_flight + s.skipped.dup_in_run
      console.log(`[fill-gaps] Complete — created ${s.created}, re-queued ${s.requeued}, skipped ${skippedTotal} ` +
        `(active ${s.skipped.already_active}, in-flight ${s.skipped.in_flight}, no-template ${s.skipped.no_template}, ` +
        `tag-mismatch ${s.skipped.tag_mismatch}, dup-in-run ${s.skipped.dup_in_run}), models-no-footage ${s.modelsNoFootage}, insert-errors ${s.insertErrors}`)
      await sendTelegram(
        `🎬 <b>FanslyTrends fill-gaps done</b>\n\n` +
        `🆕 Created: ${s.created}\n` +
        `♻️ Re-queued errored: ${s.requeued}\n` +
        (s.insertErrors > 0 ? `⚠️ Insert errors: ${s.insertErrors}\n` : '') +
        (s.modelsNoFootage > 0 ? `📭 Models w/o footage: ${s.modelsNoFootage}\n` : '') +
        `⏭ Skipped (already covered): ${skippedTotal}`
      )
    } catch (e) {
      console.error('[fill-gaps] Fatal error:', (e as Error).message)
      await sendTelegram(`🚨 <b>FanslyTrends fill-gaps failed</b>\n\n<code>${(e as Error).message.slice(0, 300)}</code>`)
    } finally {
      fillGapsRunning = false
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

// Every 30s: keep a continuous pool of RENDER_CONCURRENCY renders in flight. The old model
// processed a batch of 2 with Promise.all + a single-flight guard, so ONE slow/hung render blocked
// the other slot AND every new render for up to the wall-clock cap — collapsing throughput to
// ~1 job per stall. Now each render runs independently and a freed slot refills immediately, so a
// hung clip only ties up its own slot. processVideoJob claims atomically (guards double-pickup).
const RENDER_CONCURRENCY = parseInt(process.env.RENDER_CONCURRENCY ?? '2', 10)
let activeRenders = 0
let renderTickRunning = false
cron.schedule('*/30 * * * * *', async () => {
  if (renderTickRunning) return
  renderTickRunning = true
  try {
    while (activeRenders < RENDER_CONCURRENCY) {
      const { data: jobs } = await supabaseAdmin
        .from('video_jobs')
        .select('id')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1)

      if (!jobs || jobs.length === 0) break
      const jobId = jobs[0].id
      activeRenders++
      console.log(`[cron:jobs] Render start ${jobId} (active ${activeRenders}/${RENDER_CONCURRENCY})`)
      // Hard-timeout backstop (> the 4min render wall-clock) GUARANTEES the slot is released even
      // if processVideoJob hangs past its internal timeouts (e.g. a stuck R2 download) — otherwise
      // a leaked slot would permanently shrink the pool.
      void Promise.race([
        processVideoJob(jobId),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('render slot hard-timeout 6min')), 6 * 60 * 1000)),
      ])
        .catch(e => console.error(`[cron:jobs] Failed ${jobId}:`, (e as Error).message))
        .finally(() => { activeRenders-- })
      // Let the atomic claim (status → processing) land before selecting again, otherwise the
      // same oldest-pending row is handed out repeatedly within this loop.
      await new Promise(r => setTimeout(r, 300))
    }
  } catch (e) {
    console.error('[cron:jobs] Error:', (e as Error).message)
  } finally {
    renderTickRunning = false
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

// Every 30s: keep a continuous pool of POST_CONCURRENCY posts in flight. Same fix as the render
// pool — the old batch-of-5 + postingRunning guard meant the slowest post (up to the 4.5min master
// timer) blocked the next 5 from starting. Now posts run independently and freed slots refill. The
// cron-level 5min race + reset-to-approved is gone: postVideoJob's own master timer aborts a stalled
// post into its catch (post_fail_count++), and the watchdog reclaims a process-death (posting→approved).
// Serialized (default 1): all posts use ONE shared FanCore account; posting 3 concurrently raced
// that single account and FanCore returned 200 OK but silently dropped ~85% of submits (phantom
// 'posted' rows that never landed on the calendar). One-at-a-time trades throughput for posts that
// actually schedule. Tunable via POST_CONCURRENCY env var.
const POST_CONCURRENCY = parseInt(process.env.POST_CONCURRENCY ?? '1', 10)
let activePosts = 0
let postTickRunning = false
cron.schedule('*/30 * * * * *', async () => {
  if (postTickRunning) return
  postTickRunning = true
  try {
    while (activePosts < POST_CONCURRENCY) {
      const { data: jobs } = await supabaseAdmin
        .from('video_jobs')
        .select('id')
        .eq('status', 'approved')
        .lt('post_fail_count', 3)
        .order('created_at', { ascending: true })
        .limit(1)

      if (!jobs || jobs.length === 0) break
      const jobId = jobs[0].id
      activePosts++
      console.log(`[cron:post] Post start ${jobId} (active ${activePosts}/${POST_CONCURRENCY})`)
      // Hard-timeout backstop (> the 4.5min post master timer) GUARANTEES slot release even if
      // postVideoJob hangs past its internal timeouts — prevents the pool from shrinking over time.
      void Promise.race([
        postVideoJob(jobId),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('post slot hard-timeout 6min')), 6 * 60 * 1000)),
      ])
        .catch(e => console.error(`[cron:post] Failed ${jobId}:`, (e as Error).message))
        .finally(() => { activePosts-- })
      // Let the atomic claim (status → posting) land before selecting the next id.
      await new Promise(r => setTimeout(r, 300))
    }
  } catch (e) {
    console.error('[cron:post] Error:', (e as Error).message)
  } finally {
    postTickRunning = false
  }
})

// Every 2 min: watchdog — reclaim jobs stranded in a transient state when the process died
// mid-flight or a render hung past its wall-clock cap. This replaces relying on a full restart's
// boot-reset, so the queue self-heals without intervention.
//   processing thresh (10min) > render wall-clock cap (8min) → never yanks a live-but-slow render
//   posting   thresh (6min)  > post masterTimer (4.5min) + cron race (5min) → only fires on true death
const WATCHDOG_PROCESSING_STALE_MIN = 8
const WATCHDOG_POSTING_STALE_MIN = 6
const QUEUE_STALL_ALERT_MIN = 15   // alert if pending hasn't dropped in this long while > 0
const PROC_LEAK_CEILING = 300      // alert only on a runaway leak; normal peak (5 posts+2 renders) ~170
let watchdogRunning = false
let lastPending = -1
let lastPendingDropAt = Date.now()
let lastStuckAlertAt = 0
cron.schedule('*/2 * * * *', async () => {
  if (watchdogRunning) return
  watchdogRunning = true
  try {
    const procCutoff = new Date(Date.now() - WATCHDOG_PROCESSING_STALE_MIN * 60_000).toISOString()
    const postCutoff = new Date(Date.now() - WATCHDOG_POSTING_STALE_MIN * 60_000).toISOString()

    // Stuck renders → re-queue to pending (bounded by render_attempts), else terminal error.
    const { data: stuckProc } = await supabaseAdmin
      .from('video_jobs')
      .select('id, render_attempts')
      .eq('status', 'processing')
      .or(`started_at.is.null,started_at.lt.${procCutoff}`)
    for (const j of (stuckProc ?? []) as { id: string; render_attempts: number }[]) {
      const attempts = (j.render_attempts ?? 0) + 1
      const giveUp = attempts >= 3
      await supabaseAdmin.from('video_jobs').update({
        status: giveUp ? 'error' : 'pending',
        render_attempts: attempts,
        started_at: null,
        error_message: giveUp ? 'watchdog: render hung — attempts exhausted' : 'watchdog: render hung — re-queued',
      }).eq('id', j.id)
      console.warn(`[cron:watchdog] processing ${j.id} stale → ${giveUp ? 'error' : 'pending'} [${attempts}/3]`)
    }

    // Stuck posts → reset to approved (post cron retries; post_fail_count bounds it). The
    // masterTimer/cron-race resolve normal stalls; this only catches a process death mid-post.
    const { data: stuckPost } = await supabaseAdmin
      .from('video_jobs')
      .select('id')
      .eq('status', 'posting')
      .or(`started_at.is.null,started_at.lt.${postCutoff}`)
    if (stuckPost && stuckPost.length > 0) {
      const ids = (stuckPost as { id: string }[]).map(j => j.id)
      await supabaseAdmin.from('video_jobs').update({ status: 'approved', started_at: null }).in('id', ids)
      console.warn(`[cron:watchdog] reset ${ids.length} stale posting → approved`)
    }

    // Stuck-queue / process-leak alert (debounced ≤ 1 per QUEUE_STALL_ALERT_MIN). Tells the user
    // when the queue isn't draining or processes are leaking — the two failure modes they'd
    // otherwise only discover by manually checking.
    const { count: pendingNow } = await supabaseAdmin
      .from('video_jobs').select('id', { count: 'exact', head: true }).eq('status', 'pending')
    const pend = pendingNow ?? 0
    if (lastPending < 0 || pend < lastPending) lastPendingDropAt = Date.now()
    lastPending = pend
    const { total, chrome } = countProcs()
    const stalledMin = (Date.now() - lastPendingDropAt) / 60_000
    const queueStalled = pend > 0 && stalledMin >= QUEUE_STALL_ALERT_MIN
    const procLeak = total > PROC_LEAK_CEILING
    if ((queueStalled || procLeak) && Date.now() - lastStuckAlertAt > QUEUE_STALL_ALERT_MIN * 60_000) {
      lastStuckAlertAt = Date.now()
      const parts: string[] = []
      if (queueStalled) parts.push(`Pending stuck at ${pend} for ${Math.round(stalledMin)}min — renders may be jammed.`)
      if (procLeak) parts.push(`Process count high: ${total} (chrome ${chrome}) — possible leak.`)
      await sendTelegram(`⚠️ <b>FanslyTrends needs a look</b>\n\n${parts.join('\n')}`)
      console.warn('[cron:watchdog] sent stuck-queue alert')
    }
  } catch (e) {
    console.error('[cron:watchdog] Error:', (e as Error).message)
  } finally {
    watchdogRunning = false
  }
})

// Every 5 min: runtime reaper — sweep orphaned Chrome AND ffmpeg when counts are high and nothing
// is actively rendering/posting. Triggers on EITHER chrome over ceiling OR total procs high — the
// OOM leak showed chrome=4 but total=321 (orphaned ffmpeg/zombies), which a chrome-only check missed.
// The idle-guard is mandatory: never reap a live render/post (its ffmpeg/Chrome are in use).
const REAPER_CHROME_CEILING = 30
const REAPER_TOTAL_CEILING = 150
cron.schedule('*/5 * * * *', () => {
  const { chrome, total } = countProcs()
  if (chrome <= REAPER_CHROME_CEILING && total <= REAPER_TOTAL_CEILING) return
  if (activeRenders > 0 || activePosts > 0) {
    console.warn(`[cron:reaper] high procs (chrome=${chrome} total=${total}) but render/post in flight — skipping`)
    return
  }
  try {
    execSync('pkill -9 -f chrome-headless-shell 2>/dev/null; pkill -9 -f chromium 2>/dev/null; pkill -9 -f ffmpeg 2>/dev/null; true', { stdio: 'ignore' })
    console.warn(`[cron:reaper] Reaped orphaned Chrome/ffmpeg while idle (was chrome=${chrome}, total=${total})`)
  } catch {}
})

// Every 2 min: edge-triggered batch-complete notifier. When the in-flight queue (pending +
// processing + approved + posting + done) falls to 0 after having been >0, Telegram a summary —
// so the user never has to manually check whether a 200-500 batch finished.
let lastInFlight = -1
cron.schedule('*/2 * * * *', async () => {
  try {
    const hist = await getStatusHistogram()
    const inFlight = (hist.pending ?? 0) + (hist.processing ?? 0) + (hist.approved ?? 0) + (hist.posting ?? 0) + (hist.done ?? 0)

    if (lastInFlight > 0 && inFlight === 0) {
      const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString()
      const { count: postedRecently } = await supabaseAdmin
        .from('video_jobs').select('id', { count: 'exact', head: true }).gte('posted_at', since)
      const errCount = hist.error ?? 0
      const { data: errors } = await supabaseAdmin
        .from('video_jobs').select('error_message').eq('status', 'error').limit(500)
      let msg = `✅ <b>FanslyTrends — queue drained</b>\n\n` +
        `📤 Posted (last 24h): ${postedRecently ?? 0}\n` +
        `📦 Posted (all-time): ${hist.posted ?? 0}\n` +
        `❌ Errored (needs attention): ${errCount}`
      if (errCount > 0) {
        const reasons: Record<string, number> = {}
        for (const j of errors as { error_message: string | null }[]) {
          const key = (j.error_message ?? 'unknown').replace(/\s+/g, ' ').slice(0, 70)
          reasons[key] = (reasons[key] ?? 0) + 1
        }
        const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5)
        msg += `\n\n<b>Top failure reasons:</b>\n` + top.map(([r, c]) => `• ${c}× ${r}`).join('\n')
      }
      await sendTelegram(msg)
      console.log('[cron:batch-notify] Queue drained — sent Telegram summary')
    }
    lastInFlight = inFlight
  } catch (e) {
    console.error('[cron:batch-notify] Error:', (e as Error).message)
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
cron.schedule('0 * * * *', async () => {
  if (crmScraperRunning) {
    console.log('[cron:crm-scrape] Skipping — previous run still active')
    return
  }
  // Skip while posting queue is large — avoids adding a Chrome instance on top of active posting
  try {
    const { count } = await supabaseAdmin.from('video_jobs').select('*', { count: 'exact', head: true }).eq('status', 'approved')
    if ((count ?? 0) > 30) {
      console.log(`[cron:crm-scrape] Skipping — ${count} approved jobs active`)
      return
    }
  } catch { /* proceed if count fails */ }
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
  child.on('exit', async (code) => {
    clearTimeout(killTimer)
    crmScraperRunning = false
    console.log(`[cron:crm-scrape] Exited with code ${code}`)
    // Self-healing reconcile: scheduled_posts now reflects FanCore truth. Re-queue any 'posted'
    // job whose slot ISN'T actually on FanCore (a silent drop) so it re-posts through honest
    // verification. Bounded by post_fail_count so genuinely-unpostable jobs eventually stop.
    if (code === 0) {
      try {
        const { data: requeued, error } = await supabaseAdmin.rpc('reconcile_phantom_posts', { max_attempts: 4 })
        if (error) { console.error('[cron:reconcile] RPC error:', error.message) }
        else if ((requeued ?? 0) > 0) {
          console.warn(`[cron:reconcile] Re-queued ${requeued} phantom 'posted' jobs (on FanCore: missing) → approved`)
          await sendTelegram(`🔁 <b>FanslyTrends auto-reconcile</b>\n\nFound ${requeued} posts marked posted but missing from FanCore — re-queued to re-post.`)
        } else {
          console.log('[cron:reconcile] No phantom posts — DB matches FanCore')
        }
      } catch (e) {
        console.error('[cron:reconcile] Error:', (e as Error).message)
      }
    }
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
