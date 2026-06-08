import { type FanslyPost } from './fansly'

async function getTagId(tag: string, headers: Record<string, string>): Promise<string | null> {
  try {
    const res = await fetch(`https://apiv3.fansly.com/api/v1/contentdiscovery/media/tag?tag=${encodeURIComponent(tag)}&ngsw-bypass=true`, {
      headers: buildHeaders(headers),
    })
    if (!res.ok) return null
    const json = await res.json() as Record<string, unknown>
    const t = (json?.response as Record<string, unknown>)?.mediaOfferSuggestionTag as Record<string, unknown>
    return t?.id ? String(t.id) : null
  } catch {
    return null
  }
}

function buildHeaders(h: Record<string, string>): Record<string, string> {
  return {
    'authorization': h['authorization'],
    'fansly-client-id': h['fansly-client-id'],
    'fansly-client-ts': h['fansly-client-ts'], // never update — hash is tied to this exact value
    'fansly-client-check': h['fansly-client-check'],
    'fansly-session-id': h['fansly-session-id'],
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

function parseSuggestions(json: Record<string, unknown>): FanslyPost[] {
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
    if (s.mediaType !== 2) continue // videos only

    const am = mediaMap.get(String(s.mediaOfferId ?? ''))
    if (!am) continue

    const post = postMap.get(String(s.correlationId ?? ''))
    const likes = Math.max(
      Number(am.likeCount ?? 0),
      Number((post as Record<string,unknown>)?.likeCount ?? 0),
      Number((post as Record<string,unknown>)?.mediaLikeCount ?? 0),
    )

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

    const creatorId = String(am.accountId ?? '')
    const username = accountMap.get(creatorId) ?? 'unknown'

    const caption = (post as Record<string,unknown>)?.content as string ?? ''
    const hashtags = (caption.match(/#\w+/g) ?? []).map((t: string) => t.slice(1))

    const rawDate = (post as Record<string,unknown>)?.createdAt as number | string | null
    const postDate = rawDate ? new Date((typeof rawDate === 'number' ? rawDate * 1000 : Number(rawDate))).toISOString() : null

    posts.push({
      id: String(s.correlationId ?? s.mediaOfferId ?? s.id ?? ''),
      creator_username: username,
      caption,
      hashtags: [...new Set(hashtags)],
      likes,
      video_url: videoUrl,
      thumbnail_url: thumbnailUrl,
      duration,
      post_date: postDate,
      is_video: true,
    })
  }

  return posts
}

export async function fetchTopHashtags(n: number): Promise<string[]> {
  const res = await fetch(`https://fansly-tags.vercel.app/api/tags?sort=views&limit=${n}`)
  if (!res.ok) throw new Error(`Failed to fetch hashtags: ${res.status}`)
  const json = await res.json() as Record<string, unknown>
  const raw = (json?.mostViewed ?? json?.tags ?? []) as Record<string, unknown>[]
  return raw.slice(0, n).map(t => String(t.tag ?? '')).filter(Boolean)
}

// Scrape a pre-assigned slice of hashtags using one account's auth headers.
// Stops early once targetRaw qualifying posts (video with URL) are collected.
export async function scrapeHashtagList(
  headers: Record<string, string>,
  tags: string[],
  pagesPerTag: number,
  targetRaw: number,
): Promise<FanslyPost[]> {
  const allPosts = new Map<string, FanslyPost>()

  for (const tag of tags) {
    if (allPosts.size >= targetRaw) break

    const tagId = await getTagId(tag, headers)
    if (!tagId) {
      await new Promise(r => setTimeout(r, 500))
      continue
    }

    for (let page = 0; page < pagesPerTag; page++) {
      if (allPosts.size >= targetRaw) break

      const offset = page * 10
      try {
        const res = await fetch(
          `https://apiv3.fansly.com/api/v1/contentdiscovery/media/suggestionsnew?before=0&after=0&tagIds=${tagId}&limit=10&offset=${offset}&ngsw-bypass=true`,
          { headers: buildHeaders(headers) }
        )
        if (res.status === 429) {
          console.log(`  ⏳ Rate limited on #${tag} — waiting 60s...`)
          await new Promise(r => setTimeout(r, 60000))
          page--
          continue
        }
        if (!res.ok) break

        const json = await res.json() as Record<string, unknown>
        const pagePosts = parseSuggestions(json)
        if (pagePosts.length === 0) break

        for (const p of pagePosts) {
          if (!p.id || !p.video_url) continue
          const existing = allPosts.get(p.id)
          if (!existing || p.likes > existing.likes) allPosts.set(p.id, p)
        }

        await new Promise(r => setTimeout(r, 800))
      } catch (err) {
        console.error(`  ❌ Error on #${tag} page ${page}:`, err)
        break
      }
    }

    await new Promise(r => setTimeout(r, 500))
  }

  return Array.from(allPosts.values())
}
