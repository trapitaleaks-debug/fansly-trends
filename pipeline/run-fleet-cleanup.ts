/**
 * Fleet cleanup: delete ALL failed bulk-post records for every model (user directive 06.07.2026)
 * and snapshot capacity. Runs locally with N concurrent member sessions.
 * Run: npx ts-node --project pipeline/tsconfig.json pipeline/run-fleet-cleanup.ts [--skip handle1,handle2] [--concurrency 3]
 */
import * as dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(__dirname, '../.env.local') })

import { supabaseAdmin } from '../lib/supabase'
import { sendTelegram } from '../lib/telegram'
import { readTabCounts, cleanFailedRecords } from './fancore-hygiene'

async function run() {
  const skipArg = process.argv.find(a => a.startsWith('--skip'))
  const skip = new Set((skipArg?.split('=')[1] ?? process.argv[process.argv.indexOf('--skip') + 1] ?? '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
  const concArg = process.argv.find(a => a.startsWith('--concurrency'))
  const concurrency = parseInt(concArg?.split('=')[1] ?? '3', 10) || 3

  const { data: models } = await supabaseAdmin
    .from('trends_models')
    .select('id, fansly_username, model_number')
    .order('model_number')
  if (!models?.length) { console.error('no models'); process.exit(1) }

  const queue = (models as Array<{ id: string; fansly_username: string; model_number: number | null }>)
    .filter(m => !skip.has(m.fansly_username.toLowerCase()))
  const results: string[] = []
  let totalDeleted = 0

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const model = queue.shift()!
      const handle = model.fansly_username
      try {
        const counts = await readTabCounts(handle)
        if (counts.failed === 0) {
          console.log(`✓ @${handle}: 0 failed (all=${counts.all}) — nothing to clean`)
          await snapshot(model.model_number, counts)
          continue
        }
        console.log(`→ @${handle}: cleaning ${counts.failed}+ failed (all=${counts.all})…`)
        const res = await cleanFailedRecords(handle)
        totalDeleted += res.deleted
        await snapshot(model.model_number, res.after)
        const line = `@${handle}: deleted ${res.deleted} failed, All ${res.before.all}→${res.after.all}`
        results.push(line)
        console.log(`✓ ${line}`)
        await sendTelegram(`🧹 ${line}`).catch(() => {})
      } catch (e) {
        const line = `@${handle}: FAILED — ${(e as Error).message.slice(0, 100)}`
        results.push(line)
        console.error(`✗ ${line}`)
      }
    }
  }

  async function snapshot(modelNumber: number | null, c: { all: number; scheduled: number; sent: number; failed: number }) {
    if (modelNumber == null) return
    await supabaseAdmin.from('fancore_capacity').insert({
      model_id: modelNumber, all_count: c.all, scheduled_count: c.scheduled,
      sent_count: c.sent, failed_count: c.failed,
    })
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  const summary = `🧹 <b>Fleet cleanup complete</b>: ${totalDeleted} failed records deleted across ${results.length} models with debris`
  console.log(`\n${summary.replace(/<[^>]+>/g, '')}\n${results.join('\n')}`)
  await sendTelegram(`${summary}\n${results.slice(0, 20).join('\n')}`).catch(() => {})
}
run().catch(e => { console.error('Fatal:', e); process.exit(1) })
