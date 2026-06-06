import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.join(__dirname, '../.env.local') })
import { chromium } from 'playwright'
import { generateTOTP, secondsUntilExpiry } from './totp'
import * as fs from 'fs'

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  })
  const page = await context.newPage()

  let savedReqHeaders: Record<string, string> = {}

  page.on('response', async (res) => {
    const u = res.url()
    if (u.includes('suggestionsnew') && u.includes('tagIds=4')) {
      try {
        const req = res.request()
        savedReqHeaders = await req.allHeaders()
        const body = await res.json()
        const suggestions = body?.response?.mediaOfferSuggestions || []
        console.log('Browser suggestionsnew:', suggestions.length, 'results')
        fs.mkdirSync(path.join(__dirname, '../tmp'), { recursive: true })
        fs.writeFileSync(path.join(__dirname, '../tmp/hashtag_headers.json'), JSON.stringify(savedReqHeaders, null, 2))
        fs.writeFileSync(path.join(__dirname, '../tmp/hashtag_response.json'), JSON.stringify(body, null, 2))
      } catch { /* */ }
    }
  })

  // Login
  console.log('Logging in...')
  await page.goto('https://fansly.com', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  const enterBtn = page.locator('div.btn.solid-green:has-text("Enter"), div.btn:has-text("Enter")')
  if (await enterBtn.count() > 0) { await enterBtn.first().click(); await page.waitForTimeout(1000) }
  const loginBtn = page.locator('div.login-menu .btn:has-text("Login"), div.right-content .btn:has-text("Login")')
  if (await loginBtn.count() > 0) { await loginBtn.first().click(); await page.waitForTimeout(1000) }
  await page.waitForSelector('#fansly_login', { timeout: 10000 })
  await page.locator('#fansly_login').fill(process.env.FANSLY_EMAIL!)
  await page.waitForTimeout(300)
  await page.locator('#fansly_password').fill(process.env.FANSLY_PASSWORD!)
  await page.waitForTimeout(500)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(4000)
  const has2FA = await page.$('input[placeholder*="2fa" i], input[maxlength="6"]')
  if (has2FA) {
    const remaining = secondsUntilExpiry()
    if (remaining < 5) await page.waitForTimeout((remaining + 2) * 1000)
    await has2FA.fill(generateTOTP(process.env.FANSLY_TOTP_KEY!))
    await page.keyboard.press('Enter')
    await page.waitForTimeout(5000)
  }
  console.log('Logged in')

  await page.goto('https://fansly.com/explore/foryou/milf', { waitUntil: 'networkidle' })
  await page.waitForTimeout(4000)

  await browser.close()
  console.log('Browser closed. Headers saved.')

  if (!savedReqHeaders['authorization']) {
    console.log('ERROR: No headers captured'); return
  }

  // Now test the API directly from Node.js using the EXACT same headers
  console.log('\nTesting from Node.js with exact browser headers...')
  const tagId = '436274774033833998'
  const res = await fetch(`https://apiv3.fansly.com/api/v1/contentdiscovery/media/suggestionsnew?before=0&after=0&tagIds=${tagId}&limit=10&offset=0&ngsw-bypass=true`, {
    headers: {
      'authorization': savedReqHeaders['authorization'],
      'fansly-client-id': savedReqHeaders['fansly-client-id'],
      'fansly-client-ts': Date.now().toString(),
      'fansly-client-check': savedReqHeaders['fansly-client-check'],
      'fansly-session-id': savedReqHeaders['fansly-session-id'],
      'accept': 'application/json, text/plain, */*',
      'accept-encoding': 'gzip, deflate, br',
      'origin': 'https://fansly.com',
      'referer': 'https://fansly.com/',
      'user-agent': savedReqHeaders['user-agent'] || 'Mozilla/5.0',
      'sec-ch-ua': savedReqHeaders['sec-ch-ua'] || '',
      'sec-ch-ua-mobile': savedReqHeaders['sec-ch-ua-mobile'] || '?0',
      'sec-ch-ua-platform': savedReqHeaders['sec-ch-ua-platform'] || '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      'cookie': savedReqHeaders['cookie'] || '',
    }
  })
  const json = await res.json() as Record<string, unknown>
  const resp = (json?.response || json) as Record<string, unknown>
  const suggestions = (resp?.mediaOfferSuggestions || []) as unknown[]
  console.log('Node.js result status:', res.status, '| suggestions:', suggestions.length)
}

main().catch(console.error)
