import { supabaseAdmin } from './supabase'

// Fixed daily posting slots per model (UTC). All models share the same schedule.
// Videos generated at any time of day are queued to the next available slot.
const FIXED_SLOTS: Array<{ hour: number; minute: number }> = [
  { hour: 21, minute: 0 },
  { hour: 21, minute: 10 },
  { hour: 21, minute: 20 },
  { hour: 21, minute: 30 },
]

// FanCore rejects posts scheduled too close to current time.
const MIN_BUFFER_MS = 45 * 60 * 1000

// Returns the next available fixed slot for a model.
// Fills today's [21:00, 21:10, 21:20, 21:30] UTC first, then tomorrow's, etc.
export async function getNextSlot(modelId: string): Promise<Date> {
  const { data } = await supabaseAdmin
    .from('video_jobs')
    .select('scheduled_for')
    .eq('model_id', modelId)
    .not('scheduled_for', 'is', null)
    .gte('scheduled_for', new Date().toISOString())

  // Build set of already-taken slots (rounded to minute, as ISO strings)
  const takenMinutes = new Set<string>()
  for (const row of (data ?? [])) {
    const d = new Date(row.scheduled_for)
    // Round to minute precision for comparison
    d.setUTCSeconds(0, 0)
    takenMinutes.add(d.toISOString())
  }

  const now = new Date()
  const earliest = new Date(now.getTime() + MIN_BUFFER_MS)

  for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
    // Use UTC arithmetic — avoids DST issues
    const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset))

    for (const slot of FIXED_SLOTS) {
      const candidate = new Date(Date.UTC(
        base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(),
        slot.hour, slot.minute, 0, 0,
      ))

      if (candidate <= earliest) continue

      const key = new Date(candidate)
      key.setUTCSeconds(0, 0)
      if (takenMinutes.has(key.toISOString())) continue

      return candidate
    }
  }

  // Fallback: should never hit in practice (30-day window × 4 slots = 120 slots)
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 21, 0, 0, 0))
}
