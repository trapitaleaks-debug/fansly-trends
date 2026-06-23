import { supabaseAdmin } from './supabase'

const SLOTS_PER_DAY     = 4
const SLOT_WINDOW_START = 8   // earliest hour (UTC)
const SLOT_WINDOW_END   = 23  // latest hour (UTC)
const SLOT_MIN_GAP_MS   = 30 * 60 * 1000

// Returns the next available random slot for a model.
// Fills today first (up to SLOTS_PER_DAY), then spills to tomorrow, etc.
export async function getNextSlot(modelId: string): Promise<Date> {
  const { data } = await supabaseAdmin
    .from('video_jobs')
    .select('scheduled_for')
    .eq('model_id', modelId)
    .not('scheduled_for', 'is', null)
    .gte('scheduled_for', new Date().toISOString())

  const slotsByDay = new Map<string, Date[]>()
  for (const row of (data ?? [])) {
    const d = new Date(row.scheduled_for)
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
    if (!slotsByDay.has(key)) slotsByDay.set(key, [])
    slotsByDay.get(key)!.push(d)
  }

  const now = new Date()
  // FanCore rejects posts scheduled too close to current time — require 45-min buffer
  const earliest = new Date(now.getTime() + 45 * 60 * 1000)

  for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
    const y = now.getUTCFullYear(), mo = now.getUTCMonth(), d = now.getUTCDate() + dayOffset
    const dayKey = `${y}-${mo}-${d}`
    const taken = slotsByDay.get(dayKey) ?? []
    if (taken.length >= SLOTS_PER_DAY) continue

    for (let attempt = 0; attempt < 40; attempt++) {
      const rangeHours = SLOT_WINDOW_END - SLOT_WINDOW_START
      const hour   = SLOT_WINDOW_START + Math.floor(Math.random() * (rangeHours + 1))
      const minute = Math.floor(Math.random() * 60)
      const candidate = new Date(Date.UTC(y, mo, d, hour, minute, 0, 0))

      if (candidate <= earliest) continue
      if (taken.some(s => Math.abs(s.getTime() - candidate.getTime()) < SLOT_MIN_GAP_MS)) continue

      return candidate
    }
  }

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 12, 0, 0, 0))
}
