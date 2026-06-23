/**
 * Downloads all completed kie.ai video results to a local folder.
 *
 * How it works:
 *   1. Opens a Chromium browser at kie.ai/logs
 *   2. Waits for you to log in (you have 90 seconds)
 *   3. Paginates through all log pages, scraping 32-hex task IDs via regex
 *   4. Fetches each video URL via the API key (recordInfo)
 *   5. Downloads all .mp4 files to OUTPUT_DIR
 *
 * Usage:
 *   npx ts-node pipeline/kie-download-all.ts
 */

import { chromium } from 'playwright'
import fs from 'fs'
import https from 'https'
import http from 'http'
import path from 'path'

const API_BASE = 'https://api.kie.ai/api/v1'
const KIE_KEY = process.env.KIE_API_KEY || '8a96a0b14aafe8798b01ec5de4134e4b'
const KIE_EMAIL = 'leonardoguizzo00@gmail.com'
const KIE_PASSWORD = '09E*Yf5Sp%^UOR'
const OUTPUT_DIR = path.join(process.env.HOME || '.', 'Downloads', 'kie-videos')
const CONCURRENCY = 5

async function recordInfo(taskId: string): Promise<string | null> {
  const res = await fetch(`${API_BASE}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${KIE_KEY}` },
  })
  const json: any = await res.json()
  if (json.code !== 200 || json.data?.state !== 'success') return null
  const result = JSON.parse(json.data.resultJson ?? '{}')
  return (result.resultUrls ?? result.result_urls ?? [])[0] ?? null
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const protocol = url.startsWith('https') ? https : http
    const doGet = (u: string) =>
      protocol.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close()
          fs.unlinkSync(dest)
          return downloadFile(res.headers.location!, dest).then(resolve).catch(reject)
        }
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
      }).on('error', (e) => {
        fs.unlink(dest, () => {})
        reject(e)
      })
    doGet(url)
  })
}

async function getTaskIdsFromPage(pageText: string): Promise<string[]> {
  // Task IDs are 32-char lowercase hex strings
  const matches = [...pageText.matchAll(/\b([0-9a-f]{32})\b/g)].map(m => m[1])
  return [...new Set(matches)]
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  console.log(`\nOutput folder: ${OUTPUT_DIR}\n`)

  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext()
  const page = await context.newPage()

  await page.goto('https://kie.ai/login')
  console.log('Logging in...')

  // Fill email/password form
  try {
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10_000 })
    await page.fill('input[type="email"], input[name="email"]', KIE_EMAIL)
    await page.fill('input[type="password"], input[name="password"]', KIE_PASSWORD)
    await page.keyboard.press('Enter')
  } catch {
    // May already be logged in or using a different login flow
    console.log('Login form not found, may already be logged in.')
  }

  // Wait until the logs page shows task IDs (= logged in and data loaded)
  await page.goto('https://kie.ai/logs')
  let loggedIn = false
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000)
    const text = await page.evaluate(() => document.body.innerText)
    const ids = await getTaskIdsFromPage(text)
    if (ids.length > 0) { loggedIn = true; break }
  }

  if (!loggedIn) {
    console.log('Auto-login failed — waiting 60s for manual login in the browser window...')
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(1000)
      const text = await page.evaluate(() => document.body.innerText)
      const ids = await getTaskIdsFromPage(text)
      if (ids.length > 0) { loggedIn = true; break }
    }
  }

  if (!loggedIn) {
    console.error('Timed out waiting for login. Exiting.')
    await browser.close()
    process.exit(1)
  }
  console.log('Logged in and data visible. Collecting task IDs...\n')

  // Make sure we're on the Market tab (tab index 0)
  try {
    const marketTab = page.locator('button', { hasText: 'Market' }).first()
    await marketTab.click({ timeout: 3000 })
    await page.waitForTimeout(1000)
  } catch { /* already on market tab */ }

  const allTaskIds = new Set<string>()
  let pageNum = 1

  while (true) {
    await page.waitForTimeout(1500)
    const text = await page.evaluate(() => document.body.innerText)
    const ids = await getTaskIdsFromPage(text)
    let newCount = 0
    for (const id of ids) { if (!allTaskIds.has(id)) { allTaskIds.add(id); newCount++ } }
    console.log(`  Page ${pageNum}: found ${ids.length} IDs (${newCount} new) — total: ${allTaskIds.size}`)

    // Try to click next page arrow — try multiple selector strategies
    const clicked = await (async () => {
      // Strategy 1: aria-label
      for (const label of ['Next page', 'next page', 'Next', 'next']) {
        try {
          const btn = page.locator(`button[aria-label="${label}"]`).first()
          if (await btn.isVisible({ timeout: 500 }) && await btn.isEnabled({ timeout: 500 })) {
            await btn.click()
            return true
          }
        } catch {}
      }
      // Strategy 2: evaluate — find any non-disabled clickable with › or > text
      const found = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('button, li[role="button"], a'))
        for (const el of all) {
          const t = el.textContent?.trim() ?? ''
          const disabled = (el as HTMLButtonElement).disabled
            || el.hasAttribute('disabled')
            || el.classList.contains('disabled')
            || el.getAttribute('aria-disabled') === 'true'
          if (!disabled && (t === '›' || t === '>' || t === '›' || t === '»')) {
            ;(el as HTMLElement).click()
            return true
          }
        }
        // Strategy 3: find SVG-only next buttons by position (last non-disabled button in pagination)
        const paginationButtons = Array.from(document.querySelectorAll('[class*="pagination"] button, [class*="page"] button'))
        const lastEnabled = [...paginationButtons].reverse().find(b =>
          !(b as HTMLButtonElement).disabled && !b.hasAttribute('disabled') && !b.classList.contains('disabled')
        ) as HTMLElement | undefined
        if (lastEnabled) { lastEnabled.click(); return true }
        return false
      })
      return found
    })()

    if (!clicked) {
      // Final fallback: use "Go to page" input
      try {
        const input = page.locator('input[type="number"], input[class*="page"], input[placeholder*="page" i]').first()
        if (await input.isVisible({ timeout: 1000 })) {
          await input.fill(String(pageNum + 1))
          await input.press('Enter')
          await page.waitForTimeout(2000)
          const newText = await page.evaluate(() => document.body.innerText)
          const newIds = await getTaskIdsFromPage(newText)
          if (newIds.some(id => !allTaskIds.has(id))) {
            pageNum++
            continue
          }
        }
      } catch {}
      console.log('  No more pages.')
      break
    }
    pageNum++
    await page.waitForTimeout(2000)
  }

  await browser.close()
  console.log(`\nTotal unique task IDs: ${allTaskIds.size}`)

  const taskIds = [...allTaskIds]

  // Fetch video URLs and download in parallel batches
  let downloaded = 0
  let skipped = 0
  let failed = 0
  const total = taskIds.length

  for (let i = 0; i < taskIds.length; i += CONCURRENCY) {
    const chunk = taskIds.slice(i, i + CONCURRENCY)
    await Promise.all(chunk.map(async (taskId) => {
      const dest = path.join(OUTPUT_DIR, `${taskId}.mp4`)
      if (fs.existsSync(dest)) { skipped++; return }
      try {
        const url = await recordInfo(taskId)
        if (!url) { skipped++; return }
        await downloadFile(url, dest)
        downloaded++
        process.stdout.write(`[${downloaded + skipped + failed}/${total}] ✓ ${taskId.slice(0, 12)}...\n`)
      } catch (e) {
        failed++
        console.error(`[FAIL] ${taskId}: ${e}`)
      }
    }))
  }

  console.log(`\nDone! Downloaded: ${downloaded} | Skipped: ${skipped} | Failed: ${failed}`)
  console.log(`Files saved to: ${OUTPUT_DIR}`)
}

run().catch(console.error)
