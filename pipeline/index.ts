/**
 * Pipeline orchestrator — ties research → generate → process → telegram approval together.
 * Called by the cron server every 3 days per active model.
 */

import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { getActiveModels, getModel, createRun, updateRunStatus, getPendingApprovalRuns, getRunVideos } from './db'
import { generateBriefs } from './research'
import { generateVideos } from './generate'
import { processRun } from './process'
import { sendApprovalBatch, checkAutoApprove } from './telegram-bot'
import { postBatch } from './fancore'
import { sendTelegram } from '../lib/telegram'

export async function runPipelineForModel(handle: string): Promise<void> {
  const model = await getModel(handle)
  if (!model) throw new Error(`Model @${handle} not found in pipeline_models`)
  if (!model.active) throw new Error(`Model @${handle} is not active`)

  console.log(`\n${'='.repeat(50)}`)
  console.log(`Pipeline run: @${handle}`)
  console.log(`${'='.repeat(50)}\n`)

  let runId = ''

  try {
    // Phase 2: Research — generate 6 content briefs
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
    await processRun(runId, handle)

    // Send to Telegram for approval
    await updateRunStatus(runId, 'pending_approval')
    console.log('\n[Phase 5] Sending Telegram approval message...')
    const run = { id: runId, model_id: model.id, status: 'pending_approval', briefs, created_at: new Date().toISOString(), approved_at: null, posted_at: null }
    await sendApprovalBatch(run, handle)

    console.log(`\n✅ Pipeline run complete. Waiting for Telegram approval (auto-approve in 4h).`)

  } catch (e) {
    const msg = (e as Error).message
    console.error(`\n✗ Pipeline failed for @${handle}:`, msg)
    if (runId) await updateRunStatus(runId, 'failed')
    await sendTelegram(`🚨 <b>Pipeline failed for @${handle}</b>\n\n<code>${msg.slice(0, 300)}</code>`)
    throw e
  }
}

export async function processApprovedRuns(): Promise<void> {
  const runs = await getPendingApprovalRuns()
  const approved = runs.filter(r => r.status === 'approved')

  for (const run of approved) {
    const { data: modelRow } = await (await import('../lib/supabase')).supabaseAdmin
      .from('pipeline_models')
      .select('*')
      .eq('id', run.model_id)
      .single()

    if (!modelRow) continue

    try {
      await postBatch(run.id, modelRow)
    } catch (e) {
      console.error(`Failed to post run ${run.id}:`, (e as Error).message)
    }
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
