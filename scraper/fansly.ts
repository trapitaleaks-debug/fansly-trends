import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'
import { generateTOTP, secondsUntilExpiry } from './totp'

export interface AccountConfig {
  email: string
  password: string
  totpKey: string
}

function sessionFile(email: string) {
  return path.join(__dirname, `session_${email.replace(/[^a-z0-9]/gi, '_')}.json`)
}

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
  // Underlying Fansly media.id (the actual video file). Stable across re-serves,
  // unlike `id` (correlationId / post id) which Fansly regenerates per impression —
  // used to dedup the same video that gets wrapped in different posts over time.
  media_id?: string | null
}

interface Cookie { name: string; value: string; [key: string]: unknown }
interface SessionData {
  cookies: Cookie[]
  localStorage: Record<string, string>
  authHeaders: Record<string, string>
}

async function saveSession(context: BrowserContext, page: Page, email: string) {
  const sf = sessionFile(email)
  const cookies = await context.cookies()
  const lsRaw = await page.evaluate('JSON.stringify(Object.fromEntries(Object.entries(localStorage)))').catch(() => '{}') as string
  const localStorage = JSON.parse(lsRaw) as Record<string, string>
  const existing = fs.existsSync(sf)
    ? JSON.parse(fs.readFileSync(sf, 'utf-8')) as SessionData
    : { cookies: [], localStorage: {}, authHeaders: {} }
  fs.writeFileSync(sf, JSON.stringify({ ...existing, cookies, localStorage }, null, 2))
}

async function loadSession(context: BrowserContext, email: string): Promise<boolean> {
  const sf = sessionFile(email)
  if (!fs.existsSync(sf)) return false
  try {
    const saved = JSON.parse(fs.readFileSync(sf, 'utf-8')) as SessionData
    const cookies = Array.isArray(saved) ? saved : saved.cookies
    if (cookies?.length) await context.addCookies(cookies)
    return true
  } catch {
    return false
  }
}

async function login(page: Page, account: AccountConfig) {
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
    console.log('  📱 2FA detected...')
    const remaining = secondsUntilExpiry()
    if (remaining < 5) {
      console.log('  ⏳ Waiting for next TOTP window...')
      await page.waitForTimeout((remaining + 2) * 1000)
    }
    const code = generateTOTP(account.totpKey)
    await has2FA.fill(code)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(5000)
  }

  const session = await page.evaluate('localStorage.getItem("session_active_session")').catch(() => null) as string | null
  if (!session || session === 'null') {
    throw new Error(`Login failed for ${account.email} — no session token in localStorage after login`)
  }
  console.log(`✅ Logged in as ${account.email}`)
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

export interface ScrapeFYPResult { posts: FanslyPost[]; headers: Record<string, string> }

function buildFanslyHeaders(h: Record<string, string>): Record<string, string> {
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

// Parse the contentdiscovery/media/suggestionsnew response format (FYP + hashtag feeds).
// Uses correlationId as the post ID — this matches the fansly.com/post/{id} URL format.
function parseContentDiscovery(json: Record<string, unknown>): FanslyPost[] {
  const posts: FanslyPost[] = []
  const resp = (json?.response ?? json) as Record<string, unknown>
  const suggestions = (resp?.mediaOfferSuggestions ?? []) as Record<string, unknown>[]
  const agg = (resp?.aggregationData ?? {}) as Record<string, unknown>
  const accounts = (agg?.accounts ?? []) as Record<string, unknown>[]
  const accountMedia = (agg?.accountMedia ?? []) as Record<string, unknown>[]
  const aggPosts = (agg?.posts ?? []) as Record<string, unknown>[]

  const accountMap = new Map(accounts.map(a => [String(a.id), String(a.username ?? 'unknown')]))
  const mediaMap = new Map(accountMedia.map(m => [String(m.id), m]))
  const postMap = new Map(aggPosts.map(p => [String(p.id), p]))

  for (const s of suggestions) {
    if (s.mediaType !== 2) continue

    const am = mediaMap.get(String(s.mediaOfferId ?? ''))
    if (!am) continue

    const innerMedia = am.media as Record<string, unknown> | undefined
    if (innerMedia?.type !== 2) continue

    const locs = innerMedia.locations as Record<string, unknown>[] | undefined
    const httpsLoc = locs?.find(l => typeof l.location === 'string' && (l.location as string).startsWith('http'))
    const videoUrl = (httpsLoc?.location as string) ?? null

    const variants = innerMedia.variants as Record<string, unknown>[] | undefined
    const thumb = variants?.find(v => (v.mimetype as string)?.startsWith('image'))
    const tLocs = thumb?.locations as Record<string, unknown>[] | undefined
    const thumbnailUrl = (tLocs?.[0]?.location as string) ?? (thumb?.location as string) ?? null

    let duration = 0
    try { duration = JSON.parse(innerMedia.metadata as string ?? '{}').duration ?? 0 } catch { /* */ }

    const post = postMap.get(String(s.correlationId ?? ''))
    const caption = (post as Record<string, unknown>)?.content as string ?? ''
    const hashtags = (caption.match(/#\w+/g) ?? []).map((t: string) => t.slice(1))
    const rawDate = (post as Record<string, unknown>)?.createdAt as number | string | null
    const postDate = rawDate ? new Date((typeof rawDate === 'number' ? rawDate * 1000 : Number(rawDate))).toISOString() : null

    const likes = Math.max(
      Number(am.likeCount ?? 0),
      Number((post as Record<string, unknown>)?.likeCount ?? 0),
      Number((post as Record<string, unknown>)?.mediaLikeCount ?? 0),
    )

    // correlationId is the actual post ID (matches fansly.com/post/{id} URLs)
    const id = String(s.correlationId ?? s.mediaOfferId ?? s.id ?? '')
    if (!id) continue

    posts.push({
      id,
      creator_username: accountMap.get(String(am.accountId ?? '')) ?? 'unknown',
      caption,
      hashtags: [...new Set(hashtags)],
      likes,
      video_url: videoUrl,
      thumbnail_url: thumbnailUrl,
      duration,
      post_date: postDate,
      is_video: true,
      // Use mediaOfferId (accountMedia.id) as stable dedup key — innerMedia.id is often absent
      media_id: String(s.mediaOfferId ?? innerMedia.id ?? am.id ?? '') || null,
    })
  }
  return posts
}

export async function scrapeFYP(targetCount = 100, account?: AccountConfig): Promise<ScrapeFYPResult> {
  const acc: AccountConfig = account ?? {
    email: process.env.FANSLY_EMAIL!,
    password: process.env.FANSLY_PASSWORD!,
    totpKey: process.env.FANSLY_TOTP_KEY!,
  }
  const browser: Browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  })
  const page = await context.newPage()

  let capturedHeaders: Record<string, string> = {}

  // Capture auth headers from apiv3.fansly.com requests.
  // IMPORTANT: only accept a request that actually carries the auth token AND the
  // anti-bot signature. The FIRST apiv3 request often fires pre-login (during the
  // initial fansly.com page load) and carries only cookie/user-agent. Capturing it
  // leaves the scraper unauthenticated — and Fansly then returns `success:true` with
  // an EMPTY feed (not a 401), silently yielding 0 posts every run. Keep updating to
  // the latest authenticated request so we always end up with a usable header set.
  // NOTE: must use request.headers() (synchronous) NOT request.allHeaders() (async).
  // allHeaders() returns a Promise — if browser.close() fires before it resolves,
  // capturedHeaders never gets set and every run yields 0 posts.
  page.on('request', (request) => {
    if (!request.url().includes('apiv3.fansly.com')) return
    const h = request.headers()
    if (h['authorization'] && h['fansly-client-check']) capturedHeaders = h
  })

  // Try saved session
  const hadSession = await loadSession(context, acc.email)
  let authenticated = false
  if (hadSession) {
    try {
      const sf = sessionFile(acc.email)
      const saved = JSON.parse(fs.readFileSync(sf, 'utf-8')) as SessionData
      if (saved.localStorage) {
        await page.goto('https://fansly.com', { waitUntil: 'domcontentloaded' })
        await page.evaluate('ls => { for (const [k,v] of Object.entries(ls)) localStorage.setItem(k,v) }', saved.localStorage)
      }
    } catch { /* */ }
    await page.goto('https://fansly.com/explore/foryou', { waitUntil: 'networkidle' })
    await page.waitForTimeout(3000)
    const session = await page.evaluate('localStorage.getItem("session_active_session")').catch(() => null) as string | null
    authenticated = !!(session && session !== 'null')
    if (!authenticated) console.log('  Session expired, re-logging in...')
  }

  if (!authenticated) {
    await login(page, acc)
    await page.goto('https://fansly.com/explore/foryou', { waitUntil: 'networkidle' })
    await page.waitForTimeout(3000)
  }

  // Scroll to trigger authenticated API requests (FYP lazy-loads on scroll)
  // Wait up to 15s for capturedHeaders to populate before giving up
  let waited = 0
  while (Object.keys(capturedHeaders).length === 0 && waited < 15000) {
    await page.evaluate('window.scrollBy(0, 400)')
    await page.waitForTimeout(1000)
    waited += 1000
  }
  if (Object.keys(capturedHeaders).length === 0) {
    // One last attempt: scroll back to top and wait
    await page.evaluate('window.scrollTo(0, 0)')
    await page.waitForTimeout(3000)
  }

  await saveSession(context, page, acc.email)
  await page.waitForTimeout(1500) // let synchronous request listeners drain
  await browser.close()
  console.log('  🌐 Browser closed — auth headers captured, switching to direct API')

  if (Object.keys(capturedHeaders).length === 0) {
    throw new Error(`Failed to capture auth headers for ${acc.email}`)
  }

  // Scrape FYP via contentdiscovery endpoint (same API the hashtag scraper uses, no tagIds = global FYP)
  const postMap = new Map<string, FanslyPost>()
  const FYP_URL = 'https://apiv3.fansly.com/api/v1/contentdiscovery/media/suggestionsnew'
  const LIMIT = 20
  let offset = 0
  let noProgress = 0

  while (postMap.size < targetCount && noProgress < 5) {
    const url = `${FYP_URL}?before=0&after=0&limit=${LIMIT}&offset=${offset}&ngsw-bypass=true`
    let res: Response | null = null

    for (let retry = 0; retry < 3; retry++) {
      try {
        res = await fetch(url, { headers: buildFanslyHeaders(capturedHeaders) })
        if (res.status === 429) {
          const wait = 60 * (retry + 1)
          console.log(`  ⏳ Rate limited — waiting ${wait}s...`)
          await new Promise(r => setTimeout(r, wait * 1000))
          continue
        }
        break
      } catch (e) {
        console.error(`  ❌ Fetch error offset=${offset}:`, e)
        res = null
        break
      }
    }

    if (!res || !res.ok) {
      console.log(`  ⚠️  HTTP ${res?.status ?? 'failed'} at offset=${offset} — stopping`)
      break
    }

    const json = await res.json() as Record<string, unknown>
    const batch = parseContentDiscovery(json)

    if (batch.length === 0) { noProgress++; break }
    noProgress = 0

    const before = postMap.size
    for (const p of batch) {
      if (p.id && p.video_url) postMap.set(p.id, p)
    }

    console.log(`  🔄 offset=${offset}: +${postMap.size - before} (total: ${postMap.size}/${targetCount})`)
    offset += LIMIT
    await new Promise(r => setTimeout(r, 800))
  }

  console.log(`✅ Scrape complete: ${postMap.size} posts collected`)
  return { posts: Array.from(postMap.values()), headers: capturedHeaders }
}
