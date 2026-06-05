import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'
dotenv.config({ path: path.join(__dirname, '../.env.local') })

import { chromium } from 'playwright'

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })
  const page = await context.newPage()
  
  const posts: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST') posts.push(req.url() + ' | ' + String(req.postData()).slice(0, 100))
  })
  
  await page.goto('https://fansly.com', { waitUntil: 'networkidle' })
  const html = await page.content()
  fs.writeFileSync('/tmp/fansly-home.html', html)
  console.log('HTML:', html.length, 'bytes')
  
  const allText: string[] = []
  const els = await page.locator('button, a[href], [role="button"]').all()
  for (const el of els.slice(0, 50)) {
    const t = await el.textContent().catch(() => '')
    if (t && t.trim().length > 0 && t.trim().length < 60) allText.push(t.trim())
  }
  console.log('Clickable text elements:', [...new Set(allText)])
  
  await browser.close()
  console.log('POST requests:', posts)
}

main().catch(console.error)
