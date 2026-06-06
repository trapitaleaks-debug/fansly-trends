/**
 * Phase 7 — Analytics Scraper
 * Scrapes FanCore FYP Analytics: views per reel, follow gains, best post times.
 * Called 3 days after a run is posted.
 */

import { supabaseAdmin } from '../lib/supabase'

export interface BestTimes {
  morning: string   // HH:MM UTC, e.g. "10:00"
  evening: string   // HH:MM UTC, e.g. "18:00"
}

export async function scrapeBestTimes(handle: string): Promise<BestTimes | null> {
  // TODO: implement Playwright scrape of FanCore FYP Analytics → Best Times tab
  // Flow:
  //   1. Login to FanCore (reuse session from fancore.ts saveSession/loadSession)
  //   2. page.goto(`${FANCORE_URL}`) → select model in sidebar → FYP Analytics tab
  //   3. Click "Best Times" tab
  //   4. Extract the two peak time windows (morning + evening)
  //   5. Return as { morning: "HH:MM", evening: "HH:MM" }
  console.log(`[analytics] Best times scrape for @${handle} — not yet implemented, using defaults`)
  return null
}

export async function updateModelBestTimes(modelId: string, times: BestTimes): Promise<void> {
  const { error } = await supabaseAdmin
    .from('pipeline_models')
    .update({ best_post_times: times })
    .eq('id', modelId)
  if (error) throw new Error(`updateModelBestTimes: ${error.message}`)
  console.log(`[analytics] Updated best times for model ${modelId}: ${times.morning} / ${times.evening}`)
}

export async function runAnalyticsCycle(modelId: string, handle: string): Promise<void> {
  const times = await scrapeBestTimes(handle)
  if (times) {
    await updateModelBestTimes(modelId, times)
  }
}
