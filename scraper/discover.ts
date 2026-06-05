import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.join(__dirname, '../.env.local') })
import { chromium } from 'playwright'
import * as fs from 'fs'
import { generateTOTP, secondsUntilExpiry } from './totp'

async function run() {
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    hasTouch: true,
  })
  const page = await context.newPage()

  const timelineCallCount = { n: 0 }
  const allTimelinePosts: Record<string, unknown>[] = []
  let capturedHeaders: Record<string, string> = {}

  await context.route('**/api/v1/timeline/home**', async (route) => {
    const req = route.request()
    if (Object.keys(capturedHeaders).length === 0) {
      capturedHeaders = await req.allHeaders()
    }
    await route.continue()
  })

  page.on('response', async (response) => {
    const u = response.url()
    if (!u.includes('timeline/home')) return
    timelineCallCount.n++
    try {
      const json = await response.json() as Record<string, unknown>
      const resp = (json.response ?? json) as Record<string, unknown>
      const posts = (resp.posts ?? []) as Record<string, unknown>[]
      console.log(`  📡 timeline/home call #${timelineCallCount.n}: ${posts.length} posts (url: ${u.replace('https://apiv3.fansly.com/api/v1/','')})`)
      for (const p of posts) {
        if (!allTimelinePosts.some(x => x.id === p.id)) {
          allTimelinePosts.push(p)
        }
      }
    } catch { /* */ }
  })

  // Login
  console.log('🔑 Logging in...')
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
  const has2FA = await page.$('input[placeholder*="2fa" i], input[placeholder*="code" i], input[maxlength="6"]')
  if (has2FA) {
    const remaining = secondsUntilExpiry()
    if (remaining < 5) await page.waitForTimeout((remaining + 2) * 1000)
    const code = generateTOTP(process.env.FANSLY_TOTP_KEY!)
    console.log('  TOTP:', code)
    await has2FA.fill(code)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(5000)
  }
  const session = await page.evaluate('localStorage.getItem("session_active_session")').catch(() => null) as string | null
  if (!session || session === 'null') { console.error('❌ Login failed'); await browser.close(); return }
  console.log('✅ Logged in')

  // Navigate to FYP
  await page.goto('https://fansly.com/explore/foryou', { waitUntil: 'networkidle' })
  await page.waitForTimeout(5000)
  await page.screenshot({ path: path.join(__dirname, '../tmp/fyp_loaded.png') })
  console.log(`📊 After FYP load: ${timelineCallCount.n} timeline calls, ${allTimelinePosts.length} unique posts`)
  console.log(`  Top likes: ${allTimelinePosts.map(p=>p.likeCount).sort((a,b)=>Number(b)-Number(a)).slice(0,5).join(', ')}`)

  // Get the initial post info to verify if navigation actually changes the video
  const initInfo = await page.evaluate('(function(){ const el=document.querySelector("[class*=foryou],[class*=for-you],[class*=ForYou],app-foryou,.post-card,video"); return el ? el.className.substring(0,80) : "NOT FOUND" })()')
  console.log('  FYP element class:', initInfo)

  // Check current visible post info (username/likes)
  type VisInfo = { likes?: string; videoSrc?: string; videoPaused?: boolean }
  const getVisibleInfo = async (): Promise<VisInfo> => page.evaluate('(function(){ const likes=document.querySelector("[class*=like-count],[class*=likeCount],[class*=likes]"); const video=document.querySelector("video"); return { likes:likes?.textContent?.trim()?.substring(0,20), videoSrc:video?.src?.substring(0,80), videoPaused:video?.paused }; })()') as Promise<VisInfo>

  const before = await getVisibleInfo()
  console.log('  Before navigation:', JSON.stringify(before))

  // Dump raw structure of first post to verify likeCount field
  if (allTimelinePosts.length > 0) {
    const sample = allTimelinePosts[0] as Record<string, unknown>
    const likeFields: Record<string, unknown> = {}
    for (const k of Object.keys(sample)) {
      if (k.toLowerCase().includes('like') || k.toLowerCase().includes('count') || k.toLowerCase().includes('engagement')) {
        likeFields[k] = sample[k]
      }
    }
    console.log('  Raw like fields on first post:', JSON.stringify(likeFields))
    console.log('  Post keys:', Object.keys(sample).join(', '))
  }

  // Strategy: Try multiple navigation methods and check which one actually changes the visible content
  console.log('\n🔬 Testing navigation methods...')

  // Method 1: Click video to start playback, then simulate video ending via JS
  const callsBefore1 = timelineCallCount.n
  // First click to ensure focus
  await page.mouse.click(640, 450)
  await page.waitForTimeout(1000)
  // Try to advance video to end and dispatch ended
  for (let i = 0; i < 5; i++) {
    await page.evaluate('(function(){ const v=document.querySelector("video"); if(v){ v.currentTime=v.duration||9999; v.dispatchEvent(new Event("ended",{bubbles:true})); v.dispatchEvent(new Event("timeupdate",{bubbles:true})); } })()')
    await page.waitForTimeout(1200)
  }
  const after1 = await getVisibleInfo()
  console.log(`  Method 1 (video ended): ${timelineCallCount.n - callsBefore1} new calls, videoSrc changed: ${before.videoSrc !== after1.videoSrc}`)

  // Method 2: ArrowDown keyboard
  const callsBefore2 = timelineCallCount.n
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(1000)
  }
  const after2 = await getVisibleInfo()
  console.log(`  Method 2 (ArrowDown×8): ${timelineCallCount.n - callsBefore2} new calls, videoSrc changed: ${after1.videoSrc !== after2.videoSrc}`)

  // Method 3: Touch swipe up (now hasTouch is enabled)
  const callsBefore3 = timelineCallCount.n
  for (let i = 0; i < 5; i++) {
    await page.touchscreen.tap(640, 450)
    await page.waitForTimeout(400)
    await page.touchscreen.tap(640, 450)  // double tap might trigger advance
    await page.waitForTimeout(800)
  }
  const after3 = await getVisibleInfo()
  console.log(`  Method 3 (touch tap): ${timelineCallCount.n - callsBefore3} new calls, videoSrc changed: ${after2.videoSrc !== after3.videoSrc}`)

  // Method 4: Look for next-button chevron and click it
  const callsBefore4 = timelineCallCount.n
  const nextBtn = await page.$('[class*=chevron-down],[class*=next],[class*=arrow-down],[aria-label*="next" i],[aria-label*="down" i]')
  if (nextBtn) {
    console.log('  Found next button! Clicking...')
    for (let i = 0; i < 5; i++) {
      await nextBtn.click()
      await page.waitForTimeout(1000)
    }
  } else {
    console.log('  No next button found')
    // Try clicking the bottom part of the screen (where "next" tap zone usually is on TikTok-style)
    for (let i = 0; i < 5; i++) {
      await page.mouse.click(640, 750)
      await page.waitForTimeout(800)
    }
  }
  const after4 = await getVisibleInfo()
  console.log(`  Method 4 (next btn/bottom click): ${timelineCallCount.n - callsBefore4} new calls, videoSrc changed: ${after3.videoSrc !== after4.videoSrc}`)

  // Extended test with ArrowDown (most likely to work on desktop) - 30 presses
  console.log('\n📜 Extended ArrowDown test (30 presses)...')
  for (let i = 0; i < 30; i++) {
    const cb = timelineCallCount.n
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(800)
    if (timelineCallCount.n > cb) {
      console.log(`  🔥 New timeline batch at ArrowDown ${i+1}! Total calls: ${timelineCallCount.n}, posts: ${allTimelinePosts.length}`)
    }
    if ((i + 1) % 5 === 0) {
      const info = await getVisibleInfo()
      console.log(`  press ${i+1}: ${timelineCallCount.n} calls, ${allTimelinePosts.length} posts, likes=${info.likes}`)
    }
  }

  await page.waitForTimeout(3000)
  console.log(`\n📊 Final: ${timelineCallCount.n} timeline calls, ${allTimelinePosts.length} unique posts`)
  console.log(`  Top 10 likes: ${allTimelinePosts.map(p=>p.likeCount).sort((a,b)=>Number(b)-Number(a)).slice(0,10).join(', ')}`)

  fs.writeFileSync(path.join(__dirname, '../tmp/all_posts.json'), JSON.stringify(allTimelinePosts, null, 2))
  fs.writeFileSync(path.join(__dirname, '../tmp/auth_headers.json'), JSON.stringify(capturedHeaders, null, 2))
  console.log('💾 Saved all posts + auth headers')

  await browser.close()
}
run().catch(e => { console.error('ERROR:', e.message, e.stack?.split('\n')[1]); process.exit(1) })
