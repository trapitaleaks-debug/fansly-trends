/**
 * Standalone: manually trigger FanCore posting for approved runs.
 * Usage: npm run pipeline:post
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { supabaseAdmin } from '../lib/supabase'
import { postBatch } from './fancore'

async function main() {
  const { data: approved } = await supabaseAdmin
    .from('pipeline_runs')
    .select('*, pipeline_models(*)')
    .eq('status', 'approved')
    .order('created_at', { ascending: false })
    .limit(5)

  if (!approved?.length) {
    console.log('No approved runs found.')
    console.log('To approve: UPDATE pipeline_runs SET status=\'approved\' WHERE id=\'<run_id>\';')
    return
  }

  for (const run of approved) {
    const model = (run as any).pipeline_models
    console.log(`\nPosting run ${run.id.slice(0, 8)} for @${model.handle}...`)
    await postBatch(run.id, model)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
