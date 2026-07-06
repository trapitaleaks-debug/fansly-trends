/**
 * Delete N FAILED bulk-post records for a model to free capacity under FanCore's
 * 1000-record bulk-posting cap. Deletes ONLY cards in the "Failed" tab.
 * Run: npx ts-node --project pipeline/tsconfig.json pipeline/diag-free-slots.ts <handle> <count>
 */
import * as dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(__dirname, '../.env.local') })

import { chromium, type Page } from 'playwright'
import { resolveMemberCreds, loginFanCore, createContext, getActiveModel, FANCORE_URL, SESSION_R2_KEY } from './post-video-job'

const readCounts = (page: Page) => page.evaluate(() => {
  const out: Record<string, number> = {}
  document.querySelectorAll('button').forEach(b => {
    const m = (b.textContent ?? '').trim().match(/^(All|Scheduled|Sent|Failed)\s*\((\d+)\)$/)
    if (m) out[m[1]] = parseInt(m[2], 10)
  })
  return out
})

async function run() {
  const handle = process.argv[2]
  const target = parseInt(process.argv[3] ?? '5', 10)
  if (!handle) { console.error('usage: diag-free-slots <handle> <count>'); process.exit(1) }

  const memberCreds = await resolveMemberCreds(handle)
  const sessionKey = memberCreds ? `sessions/fancore-${handle.toLowerCase()}.json` : SESSION_R2_KEY
  const browser = await chromium.launch({ headless: true })
  try {
    const { context } = await createContext(browser, sessionKey)
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    // Deletion confirm is a NATIVE browser confirm() — Playwright auto-dismisses unless handled.
    page.on('dialog', d => { d.accept().catch(() => {}) })
    await page.goto(`${FANCORE_URL}/bulk-posts/already`, { waitUntil: 'domcontentloaded' })
    const hasLoginForm = await page.locator('input[name="password"]').isVisible({ timeout: 3_000 }).catch(() => false)
    if (page.url().includes('/signin') || hasLoginForm) {
      await loginFanCore(page, memberCreds)
      await page.goto(`${FANCORE_URL}/bulk-posts/already`, { waitUntil: 'domcontentloaded' })
    }
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    const active = await getActiveModel(page)
    if (active !== handle.toLowerCase()) throw new Error(`active model @${active} ≠ @${handle}`)

    const before = await readCounts(page)
    console.log(`before: ${JSON.stringify(before)}`)
    await page.locator('button').filter({ hasText: /^Failed \(\d+\)$/ }).first().click()
    await page.waitForTimeout(1_500)

    // The UI shows only a <=1000-record window; deleting pulls hidden older records into view,
    // so the Failed counter stays pinned until the TRUE server-side total drops below the window.
    // Delete until the counter genuinely decreases to (before - deletions) or we run dry.
    let deleted = 0
    let stuck = 0
    let lastFailedSeen = before.Failed ?? 0
    while (deleted < target && stuck < 5) {
      const trash = page.locator('button.trigger-icon-btn.danger:visible').first()
      if (!(await trash.isVisible({ timeout: 5_000 }).catch(() => false))) {
        // DOM may be exhausted in this render — reload to refill the window
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
        await page.locator('button').filter({ hasText: /^Failed \(\d+\)$/ }).first().click({ timeout: 10_000 }).catch(() => {})
        await page.waitForTimeout(1_500)
        if (!(await page.locator('button.trigger-icon-btn.danger:visible').first().isVisible({ timeout: 5_000 }).catch(() => false))) {
          console.log('no trash button after reload — Failed tab empty, stopping')
          break
        }
        continue
      }
      const delResp = page.waitForResponse(r => r.request().method() === 'DELETE' && /bulk-posts/.test(r.url()), { timeout: 8_000 }).catch(() => null)
      await trash.click()
      const resp = await delResp
      if (resp && resp.status() >= 200 && resp.status() < 300) {
        deleted++
        stuck = 0
      } else {
        stuck++
        await page.keyboard.press('Escape').catch(() => {})
        await page.waitForTimeout(500)
      }
      await page.waitForTimeout(250)
      if (deleted % 25 === 0 && deleted > 0) {
        const c = await readCounts(page)
        lastFailedSeen = c.Failed ?? lastFailedSeen
        console.log(`  deleted ${deleted}/${target} · Failed counter=${lastFailedSeen} All=${c.All}`)
        // Periodic reload keeps the giant card list from bloating memory
        if (deleted % 200 === 0) {
          await page.reload({ waitUntil: 'domcontentloaded' })
          await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
          await page.locator('button').filter({ hasText: /^Failed \(\d+\)$/ }).first().click({ timeout: 10_000 }).catch(() => {})
          await page.waitForTimeout(1_500)
        }
      }
    }

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    console.log(`FINAL: ${JSON.stringify(await readCounts(page))} (deleted ${deleted})`)
  } finally {
    await browser.close().catch(() => {})
  }
}
run().catch(e => { console.error('Fatal:', e); process.exit(1) })
