/**
 * Pipeline orchestrator — ties research → generate → process together.
 * Called by the cron server every N days per active model, or on-demand via /trigger/:handle.
 */

import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import fs from 'fs'
import os from 'os'
import path from 'path'
import { getActiveModels, getModel, createRun, updateRunStatus, getAllModels, updateModelSheetStatus } from './db'
import { supabaseAdmin } from '../lib/supabase'
import { generateBriefs } from './research'
import { generateVideos, generateCharacterSheet } from './generate'
import { processRun } from './process'

export async function runPipelineForModel(handle: string, existingRunId?: string): Promise<void> {
  const model = await getModel(handle)
  if (!model) throw new Error(`Model @${handle} not found in pipeline_models`)
  if (!model.active) throw new Error(`Model @${handle} is not active`)

  console.log(`\n${'='.repeat(50)}`)
  console.log(`Pipeline run: @${handle}`)
  console.log(`${'='.repeat(50)}\n`)

  let runId = ''

  try {
    // Phase 2: Research — generate briefs (videos_per_cycle slots)
    console.log('[Phase 2] Research...')
    const briefs = await generateBriefs(model)
    console.log(`  Generated ${briefs.length} briefs`)

    // Use provided run ID (UI-created) or create a fresh one (cron-triggered)
    if (existingRunId) {
      runId = existingRunId
      const { error } = await supabaseAdmin
        .from('pipeline_runs')
        .update({ briefs, status: 'generating' })
        .eq('id', existingRunId)
      if (error) throw new Error(`Failed to update run ${existingRunId}: ${error.message}`)
    } else {
      runId = await createRun(model.id, briefs)
    }
    console.log(`  Run ID: ${runId}`)

    // Phase 3: Generate — kie.ai images + videos
    console.log('\n[Phase 3] Generation...')
    await generateVideos(model, briefs, runId)

    // Phase 4: Process — ffmpeg overlay + audio
    console.log('\n[Phase 4] Processing...')
    await processRun(runId, handle, model)

    // Mark run as ready — no Telegram approval step
    await updateRunStatus(runId, 'ready')
    console.log('\n✅ Pipeline run complete. Status: ready.')

  } catch (e) {
    const msg = (e as Error).message
    console.error(`\n✗ Pipeline failed for @${handle}:`, msg)
    if (runId) await updateRunStatus(runId, 'failed')
    throw e
  }
}

/** Pick up models with sheet_status='queued' and generate their character sheets. */
export async function processQueuedSheets(): Promise<void> {
  const { data: models, error: sheetQueryError } = await supabaseAdmin
    .from('pipeline_models')
    .select('*')
    .eq('sheet_status', 'queued')
    .order('created_at', { ascending: true })

  if (sheetQueryError) {
    console.error('processQueuedSheets query error:', sheetQueryError.message)
    return
  }

  if (!models || models.length === 0) return

  console.log(`${models.length} queued sheet generation(s) found.`)
  for (const model of models) {
    await updateModelSheetStatus(model.id, 'generating')
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kie_sheet_'))
    try {
      console.log(`\nGenerating character sheet for @${model.handle}...`)
      await generateCharacterSheet(model, tmpDir)
      console.log(`✓ Sheet done for @${model.handle}`)
    } catch (e) {
      console.error(`✗ Sheet generation failed for @${model.handle}:`, (e as Error).message)
      await updateModelSheetStatus(model.id, 'error')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }
}

/** Pick up all runs with status='queued' and process them sequentially. */
export async function processQueuedRuns(): Promise<void> {
  const { data: queued } = await supabaseAdmin
    .from('pipeline_runs')
    .select('id, model_id, pipeline_models!inner(handle)')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })

  if (!queued || queued.length === 0) {
    console.log('No queued runs.')
    return
  }

  console.log(`${queued.length} queued run(s) found.`)
  for (const run of queued) {
    const models = (run as unknown as { pipeline_models: { handle: string }[] }).pipeline_models
    const handle = Array.isArray(models) ? models[0].handle : (models as unknown as { handle: string }).handle
    await updateRunStatus(run.id, 'generating')
    await runPipelineForModel(handle).catch(e => {
      console.error(`Failed for @${handle}:`, e.message)
    })
  }
}

// Run standalone:
//   npm run pipeline:watch                            (keep running, auto-process queued runs every 5 min)
//   npm run pipeline:run -- --handle liisaofficial   (run once for a specific model)
//   npm run pipeline:run                              (run once, process all currently queued runs)
if (require.main === module) {
  const args = process.argv.slice(2)
  const handleIdx = args.indexOf('--handle')
  const handle = handleIdx !== -1 ? args[handleIdx + 1] : undefined

  if (args.includes('--watch')) {
    console.log('Watch mode — checking for queued runs and sheets every 5 minutes. Leave this terminal open.')
    const poll = async () => {
      await processQueuedSheets().catch(e => console.error('Sheet poll error:', (e as Error).message))
      await processQueuedRuns().catch(e => console.error('Run poll error:', (e as Error).message))
      setTimeout(poll, 5 * 60 * 1000)
    }
    poll()
  } else {
    const task = handle
      ? runPipelineForModel(handle)
      : processQueuedRuns()

    task.catch(e => {
      console.error(e)
      process.exit(1)
    })
  }
}
