/**
 * Pipeline orchestrator — ties research → generate → process together.
 * Called by the cron server every N days per active model, or on-demand via /trigger/:handle.
 */

import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { getActiveModels, getModel, createRun, updateRunStatus } from './db'
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

// Run standalone: npm run pipeline:run -- --handle liisaofficial
if (require.main === module) {
  const args = process.argv.slice(2)
  const handleIdx = args.indexOf('--handle')
  const handle = handleIdx !== -1 ? args[handleIdx + 1] : undefined

  if (!handle) {
    console.error('Usage: npm run pipeline:run -- --handle <handle>')
    process.exit(1)
  }

  runPipelineForModel(handle).catch(e => {
    console.error(e)
    process.exit(1)
  })
}
