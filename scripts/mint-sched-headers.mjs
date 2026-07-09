/**
 * mint-sched-headers.mjs — mint per-model Fansly API header sets for the scheduled-posts
 * monitor and upload them to R2. Runs LOCALLY on the Mac (Fansly blocks headless login on
 * datacenter IPs; auth material lives here). Railway then reads these headers and calls
 * apiv3 /post/scheduled with plain fetch — no browser on the server.
 *
 * Depends on the fansly-onboarding-automation repo sitting next to this one
 * (../fansly-onboarding-automation) for resolveAuth + the live CRM roster + sessions/secrets.
 *
 * Usage:
 *   node scripts/mint-sched-headers.mjs                # all Active models
 *   node scripts/mint-sched-headers.mjs --only <handle>
 *   node scripts/mint-sched-headers.mjs --headed       # skip the headless first attempt
 */
import path from 'path'
import { fileURLToPath } from 'url'
import { config as dotenvConfig } from 'dotenv'

const HERE = path.dirname(fileURLToPath(import.meta.url))
dotenvConfig({ path: path.join(HERE, '../.env.local') }) // R2 creds — before S3 client construction

const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3')
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
})
const BUCKET = process.env.R2_BUCKET_NAME ?? 'fansly-trends'

const ONBOARDING = path.join(HERE, '../../fansly-onboarding-automation')
const { resolveAuth } = await import(path.join(ONBOARDING, 'scripts/lib/auth.js'))
const { MODELS } = await import(path.join(ONBOARDING, 'scripts/lib/models.js'))

const SCHEDULED_URL = 'https://apiv3.fansly.com/api/v1/post/scheduled?ngsw-bypass=true'

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1]?.replace(/^@/, '').toLowerCase() : null
const forceHeaded = args.includes('--headed')

// Same 13-key whitelist as scraper/fansly.ts buildFanslyHeaders — the proven browserless set.
function replayHeaders(h) {
  return {
    'authorization': h['authorization'] ?? '',
    'fansly-client-id': h['fansly-client-id'] ?? '',
    'fansly-client-ts': Date.now().toString(),
    'fansly-client-check': h['fansly-client-check'] ?? '',
    'fansly-session-id': h['fansly-session-id'] ?? '',
    'accept': 'application/json, text/plain, */*',
    'origin': 'https://fansly.com',
    'referer': 'https://fansly.com/',
    'user-agent': h['user-agent'] ?? 'Mozilla/5.0',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'cookie': h['cookie'] ?? '',
  }
}

// Capture the /post/scheduled request's headers from an authenticated page.
async function captureSchedHeaders(page) {
  let captured = null
  const onRequest = (request) => {
    const url = request.url()
    if (!url.includes('apiv3.fansly.com/api/v1/post/scheduled')) return
    const h = request.headers()
    if (h['authorization'] && h['fansly-client-check']) captured = h
  }
  page.on('request', onRequest)
  try {
    await page.goto('https://fansly.com/scheduled', { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {})
    for (let i = 0; i < 20 && !captured; i++) await page.waitForTimeout(1_000)
    if (!captured) { // some accounts may lazy-fire it; nudge with a reload
      await page.reload({ waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {})
      for (let i = 0; i < 15 && !captured; i++) await page.waitForTimeout(1_000)
    }
  } finally {
    page.off('request', onRequest)
  }
  return captured
}

async function mintOne(model) {
  let auth = null
  try {
    auth = await resolveAuth(model, { headless: !forceHeaded })
  } catch (e) {
    if (forceHeaded) throw e
    console.log(`  headless auth failed (${e.message.slice(0, 100)}) — retrying headed`)
    auth = await resolveAuth(model, { headless: false })
  }
  try {
    const accountId = await auth.page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('session_active_session'))?.accountId || null } catch { return null }
    }).catch(() => null)

    const headers = await captureSchedHeaders(auth.page)
    if (!headers) throw new Error('never saw an authed /post/scheduled request on fansly.com/scheduled')

    // Browserless self-test BEFORE upload — the exact call Railway will make.
    const res = await fetch(SCHEDULED_URL, { headers: replayHeaders(headers) })
    if (res.status !== 200) throw new Error(`self-test HTTP ${res.status}`)
    const json = await res.json().catch(() => null)
    if (json?.success !== true || !Array.isArray(json?.response?.scheduledPosts)) {
      throw new Error(`self-test bad envelope: ${JSON.stringify(json).slice(0, 150)}`)
    }

    const key = `sessions/fansly-sched-headers-${model.username.toLowerCase()}.json`
    const body = JSON.stringify({
      handle: model.username,
      accountId,
      capturedAt: new Date().toISOString(),
      endpoint: SCHEDULED_URL,
      headers,
    })
    await r2.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: 'application/json' }))
    return json.response.scheduledPosts.length
  } finally {
    await auth.close().catch(() => {})
  }
}

const targets = MODELS.filter(m => !only || m.username.toLowerCase() === only)
if (!targets.length) { console.error(`no Active model matches --only ${only}`); process.exit(1) }
console.log(`minting scheduled-posts headers for ${targets.length} model(s)\n`)

const dead = []
for (const model of targets) {
  process.stdout.write(`@${model.username} (#${model.num})\n`)
  try {
    const n = await mintOne(model)
    console.log(`  ✅ minted + self-tested (${n} scheduled posts) → R2\n`)
  } catch (e) {
    console.log(`  ❌ DEAD: ${e.message.slice(0, 200)}\n`)
    dead.push({ handle: model.username, reason: e.message.slice(0, 200) })
  }
}

console.log(`\n── summary ── minted ${targets.length - dead.length}/${targets.length}`)
if (dead.length) {
  console.log(`DEAD (fix creds/session, then re-run with --only <handle>):`)
  for (const d of dead) console.log(`  @${d.handle} — ${d.reason}`)
  process.exit(1)
}
