/**
 * One-off diagnostic: for each handle, login (member account when available), open
 * /bulk-posts/already and report the All/Scheduled/Sent/Failed counts plus the newest
 * entries in the FAILED tab (timestamps), to see where "vanished" submits actually go.
 * Run: npx ts-node --project pipeline/tsconfig.json pipeline/diag-tabs.ts handle1 handle2 ...
 */
import * as dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(__dirname, '../.env.local') })

import { chromium } from 'playwright'
import { resolveMemberCreds, loginFanCore, createContext, getActiveModel, FANCORE_URL, SESSION_R2_KEY } from './post-video-job'

async function run() {
  const handles = process.argv.slice(2)
  for (const handle of handles) {
    const memberCreds = await resolveMemberCreds(handle)
    const sessionKey = memberCreds ? `sessions/fancore-${handle.toLowerCase()}.json` : SESSION_R2_KEY
    const browser = await chromium.launch({ headless: true })
    try {
      const { context } = await createContext(browser, sessionKey)
      const page = await context.newPage()
      page.setDefaultTimeout(30_000)
      await page.goto(`${FANCORE_URL}/bulk-posts/already`, { waitUntil: 'domcontentloaded' })
      const hasLoginForm = await page.locator('input[name="password"]').isVisible({ timeout: 3_000 }).catch(() => false)
      if (page.url().includes('/signin') || hasLoginForm) {
        await loginFanCore(page, memberCreds)
        await page.goto(`${FANCORE_URL}/bulk-posts/already`, { waitUntil: 'domcontentloaded' })
      }
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
      const active = await getActiveModel(page)
      const counts = await page.evaluate(() => {
        const out: Record<string, string> = {}
        document.querySelectorAll('button').forEach(b => {
          const m = (b.textContent ?? '').trim().match(/^(All|Scheduled|Sent|Failed)\s*\((\d+)\)$/)
          if (m) out[m[1]] = m[2]
        })
        return out
      })
      console.log(`\n=== @${handle} (active=@${active}) counts: ${JSON.stringify(counts)}`)

      // Open the Failed tab, newest first, read the first 12 card timestamps
      const failedBtn = page.locator('button').filter({ hasText: /^Failed \(\d+\)$/ }).first()
      if (await failedBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await failedBtn.click()
        await page.waitForTimeout(1_500)
        const stamps = await page.evaluate(() => {
          const datePattern = /\d{1,2}\/\d{1,2}\/\d{4},\s*\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)/
          const walker = document.createTreeWalker(document.body, 4)
          const found: string[] = []
          let node: Node | null
          while ((node = walker.nextNode()) && found.length < 12) {
            const m = ((node as Text).textContent ?? '').match(datePattern)
            if (m) { const d = new Date(m[0]); if (!isNaN(d.getTime())) found.push(d.toISOString()) }
          }
          return found
        })
        console.log(`  FAILED tab newest entries: ${stamps.join(', ') || 'none visible'}`)
      } else {
        console.log('  (no Failed tab button found)')
      }
    } catch (e) {
      console.error(`  ✗ @${handle}: ${(e as Error).message}`)
    } finally {
      await browser.close().catch(() => {})
    }
  }
}
run().catch(e => { console.error('Fatal:', e); process.exit(1) })
