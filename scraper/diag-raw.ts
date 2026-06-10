import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'
dotenv.config({ path: path.join(__dirname, '../.env.local') })

import { chromium, type Page } from 'playwright'
import { generateTOTP, secondsUntilExpiry } from './totp'

interface Account { email: string; password: string; totpKey: string }

function loadAccounts(): Account[] {
  return JSON.parse(process.env.FANSLY_ACCOUNTS!) as Account[]
}

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
    const code = generateTOTP(account.totpKey)
    await has2FA.fill(code)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(5000)
  }
  const session = await page.evaluate('localStorage.getItem("session_active_session")').catch(() => null) as string | null
  if (!session || session === 'null') throw new Error(`Login failed for ${account.email}`)
  console.log(`✅ Logged in as ${account.email}`)
}

function buildHeaders(h: Record<string, string>): Record<string, string> {
  return {
    'authorization': h['authorization'] ?? '',
    'fansly-client-id': h['fansly-client-id'] ?? '',
    'fansly-client-ts': h['fansly-client-ts'] ?? '',
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

async function main() {
  const acc = loadAccounts()[0]
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  })
  const page = await context.newPage()

  let capturedHeaders: Record<string, string> = {}
  let firstApiHeaders: Record<string, string> = {}
  let liveDiscoveryUrl = ''
  page.on('request', async (request) => {
    const u = request.url()
    if (!u.includes('apiv3.fansly.com')) return
    if (u.includes('suggestionsnew') && !liveDiscoveryUrl) liveDiscoveryUrl = u
    try {
      const h = await request.allHeaders()
      if (Object.keys(firstApiHeaders).length === 0) firstApiHeaders = h
      // NEW capture rule: only accept an authenticated request
      if (h['authorization'] && h['fansly-client-check']) capturedHeaders = h
    } catch { /* */ }
  })

  // Capture the live FYP response the browser itself receives
  let liveDiscoveryBody: unknown = null
  page.on('response', async (res) => {
    const u = res.url()
    if (u.includes('suggestionsnew') && !liveDiscoveryBody) {
      liveDiscoveryBody = await res.json().catch(() => null)
    }
  })

  await login(page, acc)
  await page.goto('https://fansly.com/explore/foryou', { waitUntil: 'networkidle' })
  await page.waitForTimeout(5000)
  // scroll to trigger more discovery loads
  await page.mouse.wheel(0, 3000)
  await page.waitForTimeout(4000)
  await browser.close()

  console.log('\n=== FIRST apiv3 REQUEST (old capture target) ===')
  console.log('keys:', Object.keys(firstApiHeaders).filter(k => k.startsWith('fansly') || k === 'authorization' || k === 'cookie'))
  console.log('authorization present:', !!firstApiHeaders['authorization'])
  console.log('\n=== AUTHENTICATED CAPTURE (new rule) ===')
  console.log(Object.keys(capturedHeaders).filter(k => k.startsWith('fansly') || k === 'authorization' || k === 'cookie' || k === 'user-agent'))
  console.log('authorization present:', !!capturedHeaders['authorization'], 'len', (capturedHeaders['authorization'] ?? '').length)
  console.log('fansly-client-check present:', !!capturedHeaders['fansly-client-check'])
  console.log('\n=== LIVE BROWSER suggestionsnew URL ===')
  console.log(liveDiscoveryUrl)
  if (liveDiscoveryBody) {
    fs.writeFileSync('/tmp/fansly-live-discovery.json', JSON.stringify(liveDiscoveryBody, null, 2))
    const resp = (liveDiscoveryBody as any)?.response ?? liveDiscoveryBody
    console.log('LIVE response top keys:', Object.keys((liveDiscoveryBody as any) ?? {}))
    console.log('LIVE mediaOfferSuggestions count:', (resp?.mediaOfferSuggestions ?? []).length)
    console.log('LIVE aggregationData.accountMedia count:', (resp?.aggregationData?.accountMedia ?? []).length)
    console.log('LIVE success flag:', (liveDiscoveryBody as any)?.success)
    console.log('Saved live body → /tmp/fansly-live-discovery.json')
  } else {
    console.log('⚠️  No live suggestionsnew response captured by browser')
  }

  // Now replicate the scraper's own fetch
  console.log('\n=== SCRAPER-STYLE DIRECT FETCH (FYP) ===')
  const FYP = 'https://apiv3.fansly.com/api/v1/contentdiscovery/media/suggestionsnew?before=0&after=0&limit=20&offset=0&ngsw-bypass=true'
  const r = await fetch(FYP, { headers: buildHeaders(capturedHeaders) })
  console.log('HTTP status:', r.status)
  const body = await r.text()
  fs.writeFileSync('/tmp/fansly-direct-fyp.json', body)
  try {
    const json = JSON.parse(body)
    const resp = json?.response ?? json
    console.log('success flag:', json?.success)
    console.log('top keys:', Object.keys(json ?? {}))
    console.log('response keys:', Object.keys(resp ?? {}))
    console.log('mediaOfferSuggestions count:', (resp?.mediaOfferSuggestions ?? []).length)
    console.log('aggregationData.accountMedia count:', (resp?.aggregationData?.accountMedia ?? []).length)
    console.log('Saved → /tmp/fansly-direct-fyp.json')
  } catch {
    console.log('Body (first 800 chars):', body.slice(0, 800))
  }

  // Hashtag path: tag lookup then suggestions
  console.log('\n=== HASHTAG TAG LOOKUP (#teen) ===')
  const tagRes = await fetch('https://apiv3.fansly.com/api/v1/contentdiscovery/media/tag?tag=teen&ngsw-bypass=true', { headers: buildHeaders(capturedHeaders) })
  console.log('tag lookup HTTP:', tagRes.status)
  const tagJson = await tagRes.json().catch(() => null) as any
  const tagId = tagJson?.response?.mediaOfferSuggestionTag?.id
  console.log('tagId:', tagId)
  if (tagId) {
    const hRes = await fetch(`https://apiv3.fansly.com/api/v1/contentdiscovery/media/suggestionsnew?before=0&after=0&tagIds=${tagId}&limit=10&offset=0&ngsw-bypass=true`, { headers: buildHeaders(capturedHeaders) })
    console.log('hashtag suggestions HTTP:', hRes.status)
    const hBody = await hRes.text()
    fs.writeFileSync('/tmp/fansly-direct-hashtag.json', hBody)
    try {
      const hj = JSON.parse(hBody)
      const hr = hj?.response ?? hj
      console.log('hashtag mediaOfferSuggestions count:', (hr?.mediaOfferSuggestions ?? []).length)
      console.log('hashtag accountMedia count:', (hr?.aggregationData?.accountMedia ?? []).length)
      console.log('Saved → /tmp/fansly-direct-hashtag.json')
    } catch {
      console.log('hashtag body (first 500):', hBody.slice(0, 500))
    }
  }
}

main().catch(e => { console.error('DIAG FAILED:', e); process.exit(1) })
