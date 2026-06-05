import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'
dotenv.config({ path: path.join(__dirname, '../.env.local') })

import { chromium } from 'playwright'
import { generateTOTP, secondsUntilExpiry } from './totp'

const SESSION_FILE = path.join(__dirname, 'session.json')

async function main() {
  const saved = fs.existsSync(SESSION_FILE) ? JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) : null
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })
  if (saved?.cookies?.length) await context.addCookies(saved.cookies)
  const page = await context.newPage()
  
  page.on('response', async (res) => {
    const url = res.url()
    if (url.includes('timeline/home')) {
      const json = await res.json().catch(() => null)
      if (json) {
        fs.writeFileSync('/tmp/fansly-timeline-home.json', JSON.stringify(json, null, 2))
        console.log('Saved timeline/home to /tmp/fansly-timeline-home.json')
        const posts = json?.response?.posts ?? []
        console.log('Posts count:', posts.length)
        if (posts[0]) {
          console.log('First post keys:', Object.keys(posts[0]))
          console.log('First post attachments:', JSON.stringify(posts[0].attachments).slice(0, 500))
          console.log('First post likeCount:', posts[0].likeCount)
          console.log('First post accountId:', posts[0].accountId)
        }
      }
    }
    if (url.includes('timeline/home') && url.includes('accounts')) {
      console.log('accounts url:', url.slice(0, 100))
    }
  })
  
  if (saved?.localStorage) {
    await page.goto('https://fansly.com', { waitUntil: 'domcontentloaded' })
    await page.evaluate('ls => { for (const [k,v] of Object.entries(ls)) localStorage.setItem(k,v) }', saved.localStorage)
  }
  
  await page.goto('https://fansly.com/explore/foryou', { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  await browser.close()
}
main().catch(console.error)
