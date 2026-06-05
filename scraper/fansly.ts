import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'
import { generateTOTP, secondsUntilExpiry } from './totp'

const SESSION_FILE = path.join(__dirname, 'session.json')

export interface FanslyPost {
  id: string
  creator_username: string
  caption: string
  hashtags: string[]
  likes: number
  video_url: string | null
  thumbnail_url: string | null
  duration: number
  post_date: string | null
  is_video: boolean
}

interface Cookie { name: string; value: string; [key: string]: unknown }
interface SessionData {
  cookies: Cookie[]
  localStorage: Record<string, string>
  authHeaders: Record<string, string>
}

async function saveSession(context: BrowserContext, page: Page) {
  const cookies = await context.cookies()
  const lsRaw = await page.evaluate('JSON.stringify(Object.fromEntries(Object.entries(localStorage)))').catch(() => '{}') as string
  const localStorage = JSON.parse(lsRaw) as Record<string, string>
  const existing = fs.existsSync(SESSION_FILE)
    ? JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) as SessionData
    : { cookies: [], localStorage: {}, authHeaders: {} }
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ ...existing, cookies, localStorage }, null, 2))
}

async function loadSession(context: BrowserContext): Promise<boolean> {
  if (!fs.existsSync(SESSION_FILE)) return false
  try {
    const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) as SessionData
    const cookies = Array.isArray(saved) ? saved : saved.cookies
    if (cookies?.length) await context.addCookies(cookies)
    return true
  } catch {
    return false
  }
}

async function login(page: Page) {
  console.log('🔑 Logging in to Fansly...')
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

  const has2FA = await page.$('input[placeholder*="2fa" i], input[placeholder*="2FA"], input[placeholder*="code" i], input[maxlength="6"]')
  if (has2FA) {
    console.log('  📱 2FA detected...')
    const remaining = secondsUntilExpiry()
    if (remaining < 5) {
      console.log('  ⏳ Waiting for next TOTP window...')
      await page.waitForTimeout((remaining + 2) * 1000)
    }
    const code = generateTOTP(process.env.FANSLY_TOTP_KEY!)
    await has2FA.fill(code)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(5000)
  }

  const session = await page.evaluate('localStorage.getItem("session_active_session")').catch(() => null) as string | null
  if (!session || session === 'null') {
    throw new Error('Login failed — no session token in localStorage after login')
  }
  console.log('✅ Logged in')
}

function parseFanslyApiResponse(json: unknown): FanslyPost[] {
  const posts: FanslyPost[] = []
  if (!json || typeof json !== 'object') return posts
  const data = json as Record<string, unknown>
  const response = (data.response ?? data) as Record<string, unknown>

  const accountMap = new Map<string, string>()
  for (const acc of (response.accounts ?? []) as Record<string, unknown>[]) {
    if (acc.id && acc.username) accountMap.set(String(acc.id), acc.username as string)
  }

  const mediaMap = new Map<string, Record<string, unknown>>()
  for (const am of (response.accountMedia ?? []) as Record<string, unknown>[]) {
    if (am.id) mediaMap.set(String(am.id), am)
  }

  const postItems = Array.isArray(response.posts) ? response.posts as Record<string, unknown>[] : []

  for (const p of postItems) {
    if (!p?.id) continue

    let videoUrl: string | null = null
    let thumbnailUrl: string | null = null
    let duration = 0
    let isVideo = false

    const attachments = Array.isArray(p.attachments) ? p.attachments as Record<string, unknown>[] : []
    for (const att of attachments) {
      const am = mediaMap.get(String(att.contentId ?? ''))
      if (!am) continue
      const media = am.media as Record<string, unknown> | undefined
      if (!media) continue

      if ((media.type as number) === 2) {
        isVideo = true
        const locs = media.locations as Record<string, unknown>[] | undefined
        const httpsLoc = locs?.find(l => typeof l.location === 'string' && (l.location as string).startsWith('http'))
        videoUrl = (httpsLoc?.location as string) ?? null
        try { duration = JSON.parse(media.metadata as string ?? '{}').duration ?? 0 } catch { /* */ }
        const variants = media.variants as Record<string, unknown>[] | undefined
        const thumb = variants?.find(v => (v.mimetype as string)?.startsWith('image'))
        if (thumb) {
          const tLocs = thumb.locations as Record<string, unknown>[] | undefined
          thumbnailUrl = (tLocs?.[0]?.location as string) ?? (thumb.location as string) ?? null
        }
        break
      }
    }

    const username = accountMap.get(String(p.accountId ?? '')) ?? (p.username as string) ?? 'unknown'
    const caption = (p.content as string) ?? (p.text as string) ?? ''
    const hashtags = (caption.match(/#\w+/g) ?? []).map((t: string) => t.slice(1))
    const likes = Math.max(Number(p.likeCount ?? 0), Number(p.mediaLikeCount ?? 0))
    const rawDate = p.createdAt as number | string | null
    const postDate = rawDate ? new Date((typeof rawDate === 'number' ? rawDate * 1000 : Number(rawDate))).toISOString() : null

    posts.push({
      id: String(p.id),
      creator_username: username,
      caption,
      hashtags: [...new Set(hashtags)],
      likes,
      video_url: videoUrl,
      thumbnail_url: thumbnailUrl,
      duration,
      post_date: postDate,
      is_video: isVideo,
    })
  }

  return posts
}

export async function scrapeFYP(targetCount = 100): Promise<FanslyPost[]> {
  const browser: Browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  })
  const page = await context.newPage()

  const collected: FanslyPost[] = []
  const seenIds = new Set<string>()
  let capturedHeaders: Record<string, string> = {}
  let initialApiData: Record<string, unknown> | null = null

  // Capture auth headers from the browser's timeline/home request
  await context.route('**/api/v1/timeline/home**', async (route) => {
    const req = route.request()
    const headers = await req.allHeaders()
    if (Object.keys(capturedHeaders).length === 0) {
      capturedHeaders = headers
    }
    await route.continue()
  })

  // Capture the initial timeline/home response
  page.on('response', async (response) => {
    const u = response.url()
    if (!u.includes('timeline/home') || initialApiData) return
    try {
      const json = await response.json() as Record<string, unknown>
      initialApiData = (json.response ?? json) as Record<string, unknown>
    } catch { /* */ }
  })

  // Try saved session
  const hadSession = await loadSession(context)
  let authenticated = false
  if (hadSession) {
    try {
      const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) as SessionData
      if (saved.localStorage) {
        await page.goto('https://fansly.com', { waitUntil: 'domcontentloaded' })
        await page.evaluate('ls => { for (const [k,v] of Object.entries(ls)) localStorage.setItem(k,v) }', saved.localStorage)
      }
    } catch { /* */ }
    await page.goto('https://fansly.com/explore/foryou', { waitUntil: 'networkidle' })
    await page.waitForTimeout(2000)
    const session = await page.evaluate('localStorage.getItem("session_active_session")').catch(() => null) as string | null
    authenticated = !!(session && session !== 'null')
    if (!authenticated) console.log('  Session expired, re-logging in...')
  }

  if (!authenticated) {
    await login(page)
  }

  // Save session state
  await saveSession(context, page)

  // Navigate to FYP to trigger the timeline/home API call and capture auth headers
  if (!initialApiData) {
    await page.goto('https://fansly.com/explore/foryou', { waitUntil: 'networkidle' })
    await page.waitForTimeout(4000)
  }

  const initData = initialApiData as Record<string, unknown> | null
  console.log(`  📥 Initial FYP load: ${initData ? ((initData.posts as unknown[])?.length ?? 0) : 0} posts`)

  if (!initialApiData || Object.keys(capturedHeaders).length === 0) {
    await browser.close()
    throw new Error('Failed to capture API data or auth headers from FYP')
  }

  // Parse initial batch
  const initPosts = parseFanslyApiResponse({ response: initialApiData })
  for (const p of initPosts) {
    if (p.id && !seenIds.has(p.id)) {
      seenIds.add(p.id)
      collected.push(p)
    }
  }
  console.log(`  📥 Parsed ${collected.length} posts from initial batch`)

  await browser.close()
  console.log('  🌐 Browser closed — switching to direct API calls')

  // Now paginate via direct API calls (much faster than browser navigation)
  // Each call to timeline/home?before=<lastId> returns 16 new posts
  const MAX_BATCHES = Math.ceil(targetCount * 10) // generous ceiling (most batches have ~1-2 qualifying posts)
  let batchCount = 0
  let noProgressRounds = 0
  const MAX_NO_PROGRESS = 5

  while (collected.length < targetCount && batchCount < MAX_BATCHES && noProgressRounds < MAX_NO_PROGRESS) {
    const lastId = collected.length > 0 ? collected[collected.length - 1].id : '0'
    batchCount++

    const url = `https://apiv3.fansly.com/api/v1/timeline/home?before=${lastId}&after=0&mode=0&ngsw-bypass=true`
    const reqHeaders = {
      'Authorization': capturedHeaders['authorization'],
      'fansly-client-id': capturedHeaders['fansly-client-id'],
      'fansly-client-ts': Date.now().toString(),
      'fansly-client-check': capturedHeaders['fansly-client-check'],
      'fansly-session-id': capturedHeaders['fansly-session-id'],
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': capturedHeaders['user-agent'] ?? 'Mozilla/5.0',
      'Origin': 'https://fansly.com',
      'Referer': 'https://fansly.com/',
      'Cookie': capturedHeaders['cookie'] ?? '',
    }

    let retries = 0
    let res: Response | null = null
    while (retries < 3) {
      try {
        res = await fetch(url, { headers: reqHeaders })
        if (res.status === 429) {
          const wait = 60 * (retries + 1)
          console.log(`  ⏳ Rate limited (429) — waiting ${wait}s (retry ${retries + 1}/3)...`)
          await new Promise(r => setTimeout(r, wait * 1000))
          retries++
          continue
        }
        break
      } catch (err) {
        console.error(`  ❌ Batch ${batchCount} fetch error:`, err)
        noProgressRounds++
        res = null
        break
      }
    }

    if (!res || !res.ok) {
      console.log(`  ⚠️  Batch ${batchCount}: HTTP ${res?.status ?? 'failed'} — stopping`)
      break
    }

    const json = await res.json() as Record<string, unknown>
    const batchPosts = parseFanslyApiResponse(json)
    const before = collected.length

    for (const p of batchPosts) {
      if (p.id && !seenIds.has(p.id)) {
        seenIds.add(p.id)
        collected.push(p)
      }
    }

    const gained = collected.length - before
    console.log(`  🔄 Batch ${batchCount}: +${gained} (${batchPosts.length} raw), total: ${collected.length}/${targetCount}`)

    if (gained === 0) {
      noProgressRounds++
      if (noProgressRounds >= MAX_NO_PROGRESS) break
    } else {
      noProgressRounds = 0
    }

    // Polite delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 1500))
  }

  console.log(`✅ Scrape complete: ${collected.length} posts collected (${batchCount} batches)`)
  return collected
}
