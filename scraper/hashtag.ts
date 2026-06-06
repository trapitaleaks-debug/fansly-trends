import { type FanslyPost } from './fansly'

interface TagInfo { id: string; tag: string }

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
      id: String(s.mediaOfferId ?? s.id ?? ''),
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

export async function scrapeHashtags(
  headers: Record<string, string>,
  topN = 100,
  pagesPerTag = 10,
): Promise<FanslyPost[]> {
  // 1. Fetch top N hashtags from fansly-tags API
  console.log(`  📥 Fetching top ${topN} hashtags from fansly-tags...`)
  let tags: TagInfo[] = []
  try {
    const res = await fetch(`https://fansly-tags.vercel.app/api/tags?sort=views&limit=${topN}`)
    const json = await res.json() as Record<string, unknown>
    const raw = (json?.mostViewed ?? json?.tags ?? []) as Record<string, unknown>[]
    tags = raw.slice(0, topN).map(t => ({ id: '', tag: String(t.tag ?? '') })).filter(t => t.tag)
    console.log(`  ✅ Got ${tags.length} hashtags`)
  } catch (err) {
    console.error('  ❌ Failed to fetch hashtags:', err)
    return []
  }

  const allPosts = new Map<string, FanslyPost>()
  let tagsDone = 0

  for (const tagInfo of tags) {
    // 2. Look up tag ID
    const tagId = await getTagId(tagInfo.tag, headers)
    if (!tagId) {
      console.log(`  ⚠️  No ID for #${tagInfo.tag}`)
      await new Promise(r => setTimeout(r, 500))
      continue
    }

    let tagPosts = 0
    // 3. Paginate suggestions for this tag
    for (let page = 0; page < pagesPerTag; page++) {
      const offset = page * 10
      try {
        const res = await fetch(
          `https://apiv3.fansly.com/api/v1/contentdiscovery/media/suggestionsnew?before=0&after=0&tagIds=${tagId}&limit=10&offset=${offset}&ngsw-bypass=true`,
          { headers: buildHeaders(headers) }
        )
        if (res.status === 429) {
          console.log(`  ⏳ Rate limited on #${tagInfo.tag} — waiting 60s...`)
          await new Promise(r => setTimeout(r, 60000))
          page-- // retry this page
          continue
        }
        if (!res.ok) break

        const json = await res.json() as Record<string, unknown>
        const pagePosts = parseSuggestions(json)
        if (pagePosts.length === 0) break // no more results

        for (const p of pagePosts) {
          if (!p.id) continue
          const existing = allPosts.get(p.id)
          if (!existing || p.likes > existing.likes) allPosts.set(p.id, p)
          tagPosts++
        }

        await new Promise(r => setTimeout(r, 800))
      } catch (err) {
        console.error(`  ❌ Error on #${tagInfo.tag} page ${page}:`, err)
        break
      }
    }

    tagsDone++
    if (tagsDone % 10 === 0) {
      console.log(`  🏷️  ${tagsDone}/${tags.length} hashtags done | ${allPosts.size} unique posts so far`)
    }
    await new Promise(r => setTimeout(r, 500))
  }

  console.log(`  ✅ Hashtag scrape done: ${allPosts.size} unique posts from ${tagsDone} hashtags`)
  return Array.from(allPosts.values())
}
