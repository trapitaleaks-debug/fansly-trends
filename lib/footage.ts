import { supabaseAdmin } from './supabase'

// Count how many existing video_jobs use each clip (by r2_key) for a model, seeded to 0 for every
// footage row currently in the bank. Pass `statuses` to restrict the baseline (e.g. ['posted'] when
// rebalancing — count only what's already locked in on FanCore); default counts all non-error jobs.
export async function clipUsageMap(
  modelId: string,
  footage: Array<{ r2_key: string }>,
  opts?: { statuses?: string[] },
): Promise<Map<string, number>> {
  const usage = new Map<string, number>()
  for (const f of footage) usage.set(f.r2_key, 0)

  let q = supabaseAdmin
    .from('video_jobs')
    .select('model_clips(r2_key)')
    .eq('model_id', modelId)
    .not('clip_id', 'is', null)
  q = opts?.statuses?.length ? q.in('status', opts.statuses) : q.neq('status', 'error')

  const { data } = await q
  // PostgREST types the embedded relation as an array; at runtime a to-one FK is an object — handle both.
  for (const row of (data ?? []) as Array<{ model_clips: unknown }>) {
    const mc = row.model_clips
    const key = Array.isArray(mc)
      ? (mc[0] as { r2_key?: string } | undefined)?.r2_key
      : (mc as { r2_key?: string } | null)?.r2_key
    if (key && usage.has(key)) usage.set(key, (usage.get(key) ?? 0) + 1)
  }
  return usage
}

// Pick a footage row weighted toward the LEAST-used clip (weight = maxUsage − usage + 1, always ≥1),
// random within the weighting. This keeps footage evenly distributed across the bank AND means
// concurrent callers (e.g. parallel "Generate All" requests) spread across clips instead of all
// computing the same index — the old `count % length` bug that pinned a whole batch to one video.
// When balancing a sequential batch, increment the chosen clip in `usage` after each pick.
export function pickFromUsage<T extends { r2_key: string }>(footage: T[], usage: Map<string, number>): T {
  if (footage.length === 1) return footage[0]
  let maxUse = 0
  for (const f of footage) maxUse = Math.max(maxUse, usage.get(f.r2_key) ?? 0)
  const weights = footage.map(f => maxUse - (usage.get(f.r2_key) ?? 0) + 1)
  const total = weights.reduce((a, b) => a + b, 0)
  let r = Math.random() * total
  for (let i = 0; i < footage.length; i++) {
    r -= weights[i]
    if (r <= 0) return footage[i]
  }
  return footage[footage.length - 1]
}
