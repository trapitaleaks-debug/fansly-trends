import * as dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(__dirname, '../.env.local') })
import { dedupScheduledStacks } from './fancore-hygiene'
import { sendTelegram } from '../lib/telegram'
async function run() {
  for (const handle of process.argv.slice(2)) {
    const res = await dedupScheduledStacks(handle)
    console.log(`@${handle}: removed ${res.deleted} surplus copies across ${res.slotsDeduped} stacked slots`)
    await sendTelegram(`🧽 @${handle}: removed ${res.deleted} duplicate scheduled copies (${res.slotsDeduped} slots deduped)`).catch(() => {})
  }
}
run().catch(e => { console.error('Fatal:', e); process.exit(1) })
