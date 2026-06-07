/**
 * Pipeline orchestrator — ties research → generate → process together.
 * Called by the cron server every N days per active model, or on-demand via /trigger/:handle.
 */

import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { getActiveModels, getModel, createRun, updateRunStatus, getAllModels } from './db'
import { supabaseAdmin } from '../lib/supabase'
import { generateBriefs } from './research'
import { generateVideos } from './generate'
import { processRun } from './process'

export async function runPipelineForModel(handle: string): Promise<void> {
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

    // Create run record
    runId = await createRun(model.id, briefs)
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
//   npm run pipeline:run -- --handle liisaofficial   (specific model)
//   npm run pipeline:run                              (process all queued runs from web UI)
if (require.main === module) {
  const args = process.argv.slice(2)
  const handleIdx = args.indexOf('--handle')
  const handle = handleIdx !== -1 ? args[handleIdx + 1] : undefined

  const task = handle
    ? runPipelineForModel(handle)
    : processQueuedRuns()

  task.catch(e => {
    console.error(e)
    process.exit(1)
  })
}
