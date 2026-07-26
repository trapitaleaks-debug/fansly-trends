// C3 — give a slot to approved jobs that never got one.
//
// 33 jobs across 3 models have been sitting at status='approved' with scheduled_for NULL since
// 24.06.2026. The post cron only picks up jobs whose slot has arrived, so a job with no slot is
// never posted and never errors — it just sits there. This assigns each one the next free slot
// through the same getNextSlot the rest of the pipeline uses, so the 4/day/model cap and the
// 21:00–21:30 UTC window are honoured and nothing is posted in a burst.
//
// Sequential on purpose: getNextSlot reads the slots already taken, so each write is visible to the
// next call. The video_jobs_one_per_slot unique index is the real guard — on a 23505 we simply
// recompute and retry, exactly like insertVideoJobWithSlot does.
//
//   npx ts-node --project pipeline/tsconfig.json pipeline/schedule-stranded.ts --dry-run
//   npx ts-node --project pipeline/tsconfig.json pipeline/schedule-stranded.ts
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
import { supabaseAdmin } from '../lib/supabase'
import { getNextSlot, getTakenSlots, FIXED_SLOTS, MIN_BUFFER_MS } from '../lib/scheduling'

// Preview only. getNextSlot reads the DB, so in a dry run — where nothing is written — it returns
// the same slot for every job of a model and the output looks like a burst. This walks the same
// fixed slots while remembering what the preview already handed out, so the printed plan matches
// what the real run will actually do.
async function previewSlots(modelId: string, n: number): Promise<Date[]> {
  const taken = new Set(await getTakenSlots(modelId))
  const now = new Date()
  const earliest = new Date(now.getTime() + MIN_BUFFER_MS)
  const out: Date[] = []
  for (let day = 0; day < 365 && out.length < n; day++) {
    const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + day))
    for (const slot of FIXED_SLOTS) {
      if (out.length >= n) break
      const c = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), slot.hour, slot.minute, 0, 0))
      if (c <= earliest || taken.has(c.toISOString())) continue
      taken.add(c.toISOString())
      out.push(c)
    }
  }
  return out
}

const DRY = process.argv.includes('--dry-run')

async function main() {
  const { data, error } = await supabaseAdmin
    .from('video_jobs')
    .select('id, model_id, created_at')
    .eq('status', 'approved')
    .is('scheduled_for', null)
    .order('created_at', { ascending: true })   // oldest first — they have waited longest
  if (error) throw new Error(error.message)

  const jobs = (data ?? []) as Array<{ id: string; model_id: string; created_at: string }>
  console.log(`${jobs.length} approved job(s) with no slot${DRY ? '  [DRY RUN]' : ''}\n`)
  if (!jobs.length) return

  const byModel = new Map<string, number>()
  for (const j of jobs) byModel.set(j.model_id, (byModel.get(j.model_id) ?? 0) + 1)
  for (const [m, n] of byModel) console.log(`  model ${m}: ${n}`)
  console.log()

  if (DRY) {
    for (const [modelId, n] of byModel) {
      const slots = await previewSlots(modelId, n)
      const mine = jobs.filter(j => j.model_id === modelId)
      console.log(`model ${modelId}`)
      mine.forEach((j, i) => console.log(`  ${j.id}  waiting since ${j.created_at.slice(0, 10)}  →  ${slots[i]?.toISOString() ?? '(no slot found)'}`))
      const days = new Set(slots.map(s => s.toISOString().slice(0, 10)))
      console.log(`  ${n} job(s) across ${days.size} day(s): ${[...days].join(', ')}\n`)
    }
    console.log(`${jobs.length} job(s) would be scheduled, nothing written`)
    return
  }

  let assigned = 0
  const failures: Array<{ id: string; error: string }> = []

  for (const job of jobs) {
    let done = false
    for (let attempt = 0; attempt < 6 && !done; attempt++) {
      let slot: Date
      try {
        slot = await getNextSlot(job.model_id)
      } catch (e) {
        failures.push({ id: job.id, error: (e as Error).message }); break
      }

      const { error: upErr } = await supabaseAdmin
        .from('video_jobs')
        .update({ scheduled_for: slot.toISOString() })
        .eq('id', job.id)
        .is('scheduled_for', null)              // do not stomp a slot someone else just set

      if (!upErr) {
        console.log(`  ✓ ${job.id}  →  ${slot.toISOString()}`)
        assigned++; done = true
      } else if (upErr.code === '23505') {
        continue                                 // lost the slot race — recompute and retry
      } else {
        failures.push({ id: job.id, error: upErr.message }); break
      }
    }
    if (!done && !failures.some(f => f.id === job.id)) {
      failures.push({ id: job.id, error: 'slot retry exhausted (6 attempts)' })
    }
  }

  console.log(`\n${assigned} scheduled, ${failures.length} failed`)
  for (const f of failures) console.log(`  ✗ ${f.id}: ${f.error}`)

  if (!DRY) {
    const { count } = await supabaseAdmin
      .from('video_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'approved')
      .is('scheduled_for', null)
    console.log(`\nremaining approved jobs with no slot: ${count ?? '?'}`)
  }
}

main().catch(e => { console.error('FAILED:', (e as Error).message); process.exit(1) })
