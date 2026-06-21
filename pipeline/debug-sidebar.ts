import * as dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(__dirname, '../.env.local') })

import { chromium } from 'playwright'
import { r2 } from '../lib/r2'
import { GetObjectCommand } from '@aws-sdk/client-s3'

const FANCORE_URL = 'https://fancore-production.up.railway.app'
const BUCKET = process.env.R2_BUCKET_NAME ?? 'fansly-trends'

async function run() {
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'sessions/fancore.json' }))
  const chunks: Uint8Array[] = []
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk)
  const savedState = JSON.parse(Buffer.concat(chunks).toString())

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ timezoneId: 'UTC', storageState: savedState as any })
  const page = await context.newPage()

  await page.goto(`${FANCORE_URL}/bulk-posts/already`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})

  // Dump all text nodes that contain @
  const atTexts: string[] = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, 4)
    const found: string[] = []
    let node: Node | null
    while ((node = walker.nextNode())) {
      const t = (node as Text).textContent?.trim() ?? ''
      if (t.startsWith('@') && t.length > 1) found.push(t)
    }
    return found
  })
  console.log('All @text nodes:', JSON.stringify(atTexts))

  // Try exact match
  const entry = page.getByText('@XiaohongshuShawty', { exact: true }).first()
  const visible = await entry.isVisible({ timeout: 5000 }).catch(() => false)
  console.log('@XiaohongshuShawty exact visible:', visible)

  // Try partial
  const partial = page.locator('text=XiaohongshuSha').first()
  const partialVis = await partial.isVisible({ timeout: 3000 }).catch(() => false)
  console.log('XiaohongshuSha partial visible:', partialVis)
  if (partialVis) console.log('partial textContent:', await partial.textContent())

  // Also check what Scheduled buttons exist before any click
  const scheduledBtns = await page.locator('button').filter({ hasText: /Scheduled/ }).allTextContents()
  console.log('Scheduled buttons (no model selected):', scheduledBtns)

  await browser.close()
}

run().catch(console.error)
