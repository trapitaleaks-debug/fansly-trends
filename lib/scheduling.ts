import { supabaseAdmin } from './supabase'

// Fixed daily posting slots per model (UTC). All models share the same schedule.
// Exactly 4 slots/day → at most 4 videos/day/model (one video per slot, enforced by the
// video_jobs_one_per_slot partial unique index + the taken-slot scan below).
const FIXED_SLOTS: Array<{ hour: number; minute: number }> = [
  { hour: 21, minute: 0 },
  { hour: 21, minute: 10 },
  { hour: 21, minute: 20 },
  { hour: 21, minute: 30 },
]

// FanCore rejects posts scheduled too close to current time.
const MIN_BUFFER_MS = 45 * 60 * 1000

// Unique-index names, used to tell the two 23505 conflicts apart in insertVideoJobWithSlot.
const SLOT_INDEX = 'video_jobs_one_per_slot'                 // (model_id, scheduled_for)
const POST_DEDUP_INDEX = 'video_jobs_one_active_per_model_post' // (model_id, post_id)

function addMinuteKey(set: Set<string>, value: string | null | undefined): void {
  if (!value) return
  const d = new Date(value)
  d.setUTCSeconds(0, 0)
  set.add(d.toISOString())
}

// All minute-slots already occupied for this model — BOTH our own scheduled video_jobs AND posts
// already on FanCore (scheduled_posts). Counting FanCore-existing enforces the hard 4/day even
// across what's already live (a day with 4 already on FanCore yields 0 new). 'error' jobs are
// excluded so a failed slot becomes reusable.
async function getTakenSlots(modelId: string): Promise<Set<string>> {
  const taken = new Set<string>()
  const startOfToday = new Date()
  startOfToday.setUTCHours(0, 0, 0, 0)
  const startIso = startOfToday.toISOString()

  // (a) our own non-error jobs from today forward — each holds its slot
  const { data: jobs } = await supabaseAdmin
    .from('video_jobs')
    .select('scheduled_for')
    .eq('model_id', modelId)
    .neq('status', 'error')
    .not('scheduled_for', 'is', null)
    .gte('scheduled_for', startIso)
  for (const row of (jobs ?? []) as Array<{ scheduled_for: string }>) addMinuteKey(taken, row.scheduled_for)

  // (b) posts already on FanCore. scheduled_posts.model_id is trends_models.model_number (int),
  // not the uuid — resolve the mapping first.
  const { data: model } = await supabaseAdmin
    .from('trends_models')
    .select('model_number')
    .eq('id', modelId)
    .maybeSingle()
  const modelNumber = (model as { model_number: number | null } | null)?.model_number
  if (modelNumber != null) {
    const { data: fc } = await supabaseAdmin
      .from('scheduled_posts')
      .select('scheduled_for')
      .eq('model_id', modelNumber)
      .gte('scheduled_for', startIso)
    for (const row of (fc ?? []) as Array<{ scheduled_for: string }>) addMinuteKey(taken, row.scheduled_for)
  }

  return taken
}

// Returns the next free fixed slot for a model. Fills today's [21:00..21:30] UTC first, then
// tomorrow's, etc. — skipping any slot already taken by our own jobs OR already on FanCore. No
// horizon cap (videos roll arbitrarily far ahead); the 365-day bound is only an infinite-loop guard.
export async function getNextSlot(modelId: string): Promise<Date> {
  const taken = await getTakenSlots(modelId)

  const now = new Date()
  const earliest = new Date(now.getTime() + MIN_BUFFER_MS)

  for (let dayOffset = 0; dayOffset < 365; dayOffset++) {
    const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset))
    for (const slot of FIXED_SLOTS) {
      const candidate = new Date(Date.UTC(
        base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(),
        slot.hour, slot.minute, 0, 0,
      ))
      if (candidate <= earliest) continue
      // candidate is already at :00 seconds / .000 ms, matching the rounded taken keys
      if (taken.has(candidate.toISOString())) continue
      return candidate
    }
  }

  throw new Error(`getNextSlot: no free slot within 365 days for model ${modelId}`)
}

export type InsertSlotResult =
  | { status: 'created'; id?: string }
  | { status: 'skipped_duplicate' }
  | { status: 'error'; error: string }

// Insert a video_job with a collision-free slot. The video_jobs_one_per_slot unique index makes the
// slot a real reservation: if a concurrent writer grabbed the slot first, the insert throws 23505 and
// we recompute getNextSlot (which now sees the competitor) and retry. A 23505 on the post-dedup index
// instead means this model already has an active job for the post → skipped (existing behavior).
export async function insertVideoJobWithSlot(
  modelId: string,
  payload: Record<string, unknown>,
  opts?: { returnId?: boolean },
): Promise<InsertSlotResult> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const scheduledFor = await getNextSlot(modelId)
    const row = { ...payload, scheduled_for: scheduledFor.toISOString() }
    const { data, error } = opts?.returnId
      ? await supabaseAdmin.from('video_jobs').insert(row).select('id').single()
      : await supabaseAdmin.from('video_jobs').insert(row)
    if (!error) return { status: 'created', id: (data as { id: string } | null)?.id }

    const detail = `${error.message} ${(error as { details?: string }).details ?? ''}`
    if (error.code === '23505') {
      if (detail.includes(SLOT_INDEX)) continue            // lost the slot race — recompute & retry
      if (detail.includes(POST_DEDUP_INDEX)) return { status: 'skipped_duplicate' }
    }
    return { status: 'error', error: error.message }
  }
  return { status: 'error', error: 'slot retry exhausted (6 attempts)' }
}

export { SLOT_INDEX }
