import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.join(__dirname, '../.env.local') })

import { chromium, type Page } from 'playwright'
import { generateTOTP, secondsUntilExpiry } from './totp'

interface Account { email: string; password: string; totpKey: string }
const loadAccounts = (): Account[] => JSON.parse(process.env.FANSLY_ACCOUNTS!) as Account[]

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const SBH = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function login(page: Page, account: Account) {
  console.log(`🔑 Logging in as ${account.email}...`)
  await page.goto('https://fansly.com', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  const enterBtn = page.locator('div.btn.solid-green:has-text("Enter"), div.btn:has-text("Enter")')
  if (await enterBtn.count() > 0) { await enterBtn.first().click(); await page.waitForTimeout(1000) }
  const loginBtn = page.locator('div.login-menu .btn:has-text("Login"), div.right-content .btn:has-text("Login")')
  if (await loginBtn.count() > 0) { await loginBtn.first().click(); await page.waitForTimeout(1000) }
  await page.waitForSelector('#fansly_login', { timeout: 10000 })
  await page.locator('#fansly_login').fill(account.email)
  await page.waitForTimeout(300)
  await page.locator('#fansly_password').fill(account.password)
  await page.waitForTimeout(500)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(4000)
  const has2FA = await page.$('input[placeholder*="2fa" i], input[placeholder*="2FA"], input[placeholder*="code" i], input[maxlength="6"]')
  if (has2FA) {
    const remaining = secondsUntilExpiry()
    if (remaining < 5) await page.waitForTimeout((remaining + 2) * 1000)
    await has2FA.fill(generateTOTP(account.totpKey))
    await page.keyboard.press('Enter')
    await page.waitForTimeout(5000)
  }
  const session = await page.evaluate('localStorage.getItem("session_active_session")').catch(() => null) as string | null
  if (!session || session === 'null') throw new Error(`Login failed for ${account.email}`)
  console.log(`✅ Logged in`)
}

function buildHeaders(h: Record<string, string>): Record<string, string> {
  return {
    'authorization': h['authorization'] ?? '', 'fansly-client-id': h['fansly-client-id'] ?? '',
    'fansly-client-ts': h['fansly-client-ts'] ?? '', 'fansly-client-check': h['fansly-client-check'] ?? '',
    'fansly-session-id': h['fansly-session-id'] ?? '', 'accept': 'application/json, text/plain, */*',
    'origin': 'https://fansly.com', 'referer': 'https://fansly.com/',
    'user-agent': h['user-agent'] ?? 'Mozilla/5.0', 'cookie': h['cookie'] ?? '',
  }
}

// post.attachments[].contentId -> accountMedia.id ; accountMedia.media.id = the stable video file id
function resolveMediaIds(json: any, wantIds: Set<string>): Map<string, string> {
  const r = json?.response ?? json
  const posts = (r?.posts ?? []) as any[]
  const accountMedia = (r?.accountMedia ?? r?.aggregationData?.accountMedia ?? []) as any[]
  const bundles = (r?.accountMediaBundles ?? r?.aggregationData?.accountMediaBundles ?? []) as any[]
  const amMap = new Map(accountMedia.map(m => [String(m.id), m]))
  const bundleMap = new Map(bundles.map(b => [String(b.id), b]))
  const out = new Map<string, string>()
  for (const p of posts) {
    const pid = String(p.id)
    if (!wantIds.has(pid)) continue
    for (const att of (p.attachments ?? [])) {
      const cid = String(att.contentId ?? '')
      let am = amMap.get(cid)
      if (!am && bundleMap.get(cid)) {
        // attachment is a bundle — take its first accountMedia content
        const firstContent = bundleMap.get(cid)?.accountMediaIds?.[0] ?? bundleMap.get(cid)?.bundleContent?.[0]?.accountMediaId
        if (firstContent) am = amMap.get(String(firstContent))
      }
      const mediaId = am?.media?.id ?? am?.media?.mediaId
      if (mediaId) { out.set(pid, String(mediaId)); break }
    }
  }
  return out
}

async function main() {
  const testMode = process.argv.includes('--test')
  const acc = loadAccounts()[0]
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  })
  const page = await context.newPage()
  let headers: Record<string, string> = {}
  page.on('request', async (req) => {
    if (!req.url().includes('apiv3.fansly.com')) return
    try { const h = await req.allHeaders(); if (h['authorization'] && h['fansly-client-check']) headers = h } catch { /* */ }
  })
  await login(page, acc)
  await page.goto('https://fansly.com/explore/foryou', { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  await browser.close()
  if (!headers['authorization']) throw new Error('no auth headers captured')

  // fetch active posts lacking media id
  let rows: { fansly_post_id: string }[] = [], from = 0
  while (true) {
    const res = await fetch(`${SB}/rest/v1/trends_posts?archived_at=is.null&fansly_media_id=is.null&select=fansly_post_id&order=fansly_post_id&offset=${from}&limit=1000`, { headers: SBH })
    const batch = await res.json() as { fansly_post_id: string }[]
    rows.push(...batch)
    if (batch.length < 1000) break
    from += 1000
  }
  console.log(`posts needing media_id: ${rows.length}`)
  if (testMode) rows = rows.slice(0, 30)

  const BATCH = 40
  let resolved = 0, unresolved = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    const ids = chunk.map(r => r.fansly_post_id)
    const want = new Set(ids)
    const url = `https://apiv3.fansly.com/api/v1/post?ids=${ids.join(',')}&ngsw-bypass=true`
    let media = new Map<string, string>()
    try {
      const res = await fetch(url, { headers: buildHeaders(headers) })
      if (res.ok) media = resolveMediaIds(await res.json(), want)
      else console.log(`  HTTP ${res.status} at batch ${i}`)
    } catch (e) { console.log(`  fetch err batch ${i}: ${(e as Error).message}`) }

    // update resolved rows
    const updates = [...media.entries()]
    for (const [pid, mid] of updates) {
      await fetch(`${SB}/rest/v1/trends_posts?fansly_post_id=eq.${pid}`, {
        method: 'PATCH', headers: { ...SBH, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ fansly_media_id: mid }),
      })
    }
    resolved += updates.length
    unresolved += chunk.length - updates.length
    if (i % 200 === 0) console.log(`  ${i + chunk.length}/${rows.length} processed — resolved ${resolved}, unresolved ${unresolved}`)
    await new Promise(r => setTimeout(r, 600))
  }
  console.log(`\n✅ Backfill done — resolved ${resolved}, unresolved ${unresolved} (post deleted/private on Fansly)`)
}

main().catch(e => { console.error('BACKFILL FAILED:', e); process.exit(1) })
