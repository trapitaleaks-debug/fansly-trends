import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.join(__dirname, '../.env.local') })
import { scrapeFYP, type AccountConfig, type FanslyPost } from './fansly'
import { fetchTopHashtags, scrapeHashtagList } from './hashtag'
import { uploadBuffer, downloadUrl } from './storage'
import { upsertPost, getBlacklist, getExistingPostIds, getExistingMediaIds, batchUpdateLikes, getClient, enforceCreatorCap } from './db'
import { sendTelegram, scraperSuccess, scraperError } from '../lib/telegram'

const MIN_LIKES = 150
const TARGET_COUNT = 4000
const RAW_COLLECT_PER_ACCOUNT = 300
const HASHTAG_TOP_N = 150
const HASHTAG_PAGES_PER_TAG = 12
const MIN_POSTS_PER_ACCOUNT = 500   // each account targets this many raw posts from its hashtags
const MAX_POSTS_PER_CREATOR = 20    // max posts per creator in DB at any time

const BANNED_HASHTAGS = new Set([
  'deepthroat','porn','creampie','hotwife','bigdick','breeding','analcreampie',
  'sex','bbc','bwc','bigcock','hugecock','hugedick','swingers','couple','couples',
  'wifesharing','wifeswap','blacked','monstercock','gangbang',
  'cumslut','analsex','cumeating','fuck','bg','sextape','standingfuck',
])

function loadAccounts(): AccountConfig[] {
  if (process.env.FANSLY_ACCOUNTS) {
    try {
      return JSON.parse(process.env.FANSLY_ACCOUNTS) as AccountConfig[]
    } catch {
      console.warn('⚠️  FANSLY_ACCOUNTS is not valid JSON — falling back to single account env vars')
    }
  }
  return [{
    email: process.env.FANSLY_EMAIL!,
    password: process.env.FANSLY_PASSWORD!,
    totpKey: process.env.FANSLY_TOTP_KEY!,
  }]
}

async function main() {
  console.log('🚀 FanslyTrends scraper starting...')
  const startTime = Date.now()

  let added = 0, updated = 0, skipped = 0

  try {
    const blacklist = await getBlacklist()
    console.log(`📋 Blacklist loaded: ${blacklist.length} usernames`)

    const accounts = loadAccounts()
    console.log(`👥 Accounts: ${accounts.length}`)

    const postMap = new Map<string, FanslyPost>()
    const accountHeaders: Array<{ email: string; headers: Record<string, string> }> = []

    // Phase 1: FYP scraping across all accounts — capture auth headers per account
    console.log('\n--- Phase 1: FYP scraping ---')
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i]
      console.log(`\n📡 Account ${i + 1}/${accounts.length}: ${acc.email}`)
      try {
        const { posts, headers } = await scrapeFYP(RAW_COLLECT_PER_ACCOUNT, acc)
        if (Object.keys(headers).length > 0) {
          accountHeaders.push({ email: acc.email, headers })
        }
        let fresh = 0
        for (const p of posts) {
          if (!p.id) continue
          const existing = postMap.get(p.id)
          if (!existing || p.likes > existing.likes) {
            postMap.set(p.id, p)
            if (!existing) fresh++
          }
        }
        console.log(`  ✅ Scrape complete: ${posts.length} posts collected`)
        console.log(`  +${fresh} unique posts (${postMap.size} total so far)`)
      } catch (err) {
        console.error(`  ❌ Account ${acc.email} failed:`, err instanceof Error ? err.message : err)
      }
    }

    // Phase 2: Hashtag scraping — top 150 tags distributed across all accounts
    if (accountHeaders.length > 0) {
      console.log(`\n--- Phase 2: Hashtag scraping (top ${HASHTAG_TOP_N} tags, ${accountHeaders.length} accounts) ---`)

      const allTags = await fetchTopHashtags(HASHTAG_TOP_N)
      console.log(`  ✅ ${allTags.length} hashtags fetched`)

      const chunkSize = Math.ceil(allTags.length / accountHeaders.length)

      for (let i = 0; i < accountHeaders.length; i++) {
        const { email, headers } = accountHeaders[i]
        const tagSlice = allTags.slice(i * chunkSize, (i + 1) * chunkSize)
        console.log(`\n  📡 Account ${i + 1}/${accountHeaders.length} (${email}): ${tagSlice.length} tags → target ${MIN_POSTS_PER_ACCOUNT} posts`)

        try {
          const posts = await scrapeHashtagList(headers, tagSlice, HASHTAG_PAGES_PER_TAG, MIN_POSTS_PER_ACCOUNT)
          let fresh = 0
          for (const p of posts) {
            if (!p.id) continue
            const existing = postMap.get(p.id)
            if (!existing || p.likes > existing.likes) {
              postMap.set(p.id, p)
              if (!existing) fresh++
            }
          }
          console.log(`  ✅ +${fresh} fresh posts (${posts.length} collected, postMap: ${postMap.size})`)
        } catch (err) {
          console.error(`  ❌ Hashtag scraping failed for ${email}:`, err instanceof Error ? err.message : err)
        }
      }
    } else {
      console.log('\n⚠️  No auth headers captured — skipping hashtag scraping')
    }

    // Phase 3: Process and save qualifying posts
    const qualifying = Array.from(postMap.values())
      .filter(p => {
        if (!p.id || !p.is_video || !p.video_url || p.likes < MIN_LIKES) return false
        if (blacklist.includes(p.creator_username.toLowerCase())) return false
        if (p.hashtags.some(h => BANNED_HASHTAGS.has(h.toLowerCase()))) return false
        return true
      })
      .sort((a, b) => b.likes - a.likes)

    // Collapse in-batch duplicates: the same video (media_id) is re-served under
    // different post ids. List is sorted by likes desc, so keep the first (highest) copy.
    const seenMedia = new Set<string>()
    const allPosts = qualifying.filter(p => {
      if (!p.media_id) return true
      if (seenMedia.has(p.media_id)) return false
      seenMedia.add(p.media_id)
      return true
    })
    const inBatchDupes = qualifying.length - allPosts.length

    console.log(`\n--- Phase 3: Processing ${allPosts.length} qualifying posts (≥${MIN_LIKES} likes, videos only; collapsed ${inBatchDupes} in-batch dupes) ---`)

    const existingIds = await getExistingPostIds(allPosts.map(p => p.id))
    const existingMediaIds = await getExistingMediaIds(allPosts.map(p => p.media_id ?? '').filter(Boolean))

    const existingPosts = allPosts.filter(p => existingIds.has(p.id))
    if (existingPosts.length > 0) {
      await batchUpdateLikes(existingPosts.map(p => ({ fansly_post_id: p.id, likes_current: p.likes })))
      updated = existingPosts.length
      console.log(`  🔄 Batch-updated likes for ${updated} existing posts`)
    }

    // New = unseen post id AND not an already-stored video (same media_id under a new post id)
    const newPosts = allPosts.filter(p =>
      !existingIds.has(p.id) && !(p.media_id && existingMediaIds.has(p.media_id))
    )
    const skippedDupVideos = allPosts.filter(p =>
      !existingIds.has(p.id) && p.media_id && existingMediaIds.has(p.media_id)
    ).length
    console.log(`  📦 ${existingIds.size} already in DB, ${skippedDupVideos} skipped (same video, new post id), ${newPosts.length} new`)
    console.log(`\n  ✨ Downloading and saving ${newPosts.length} new posts...`)

    for (const post of newPosts) {
      if (added >= TARGET_COUNT) { skipped++; continue }

      try {
        let videoKey = ''
        let thumbnailKey = ''

        if (post.video_url && post.video_url.startsWith('http')) {
          videoKey = `videos/${post.id}.mp4`
          const videoBuffer = await downloadUrl(post.video_url)
          await uploadBuffer(videoKey, videoBuffer, 'video/mp4')
        }

        if (post.thumbnail_url && post.thumbnail_url.startsWith('http')) {
          thumbnailKey = `thumbs/${post.id}.jpg`
          const thumbBuffer = await downloadUrl(post.thumbnail_url)
          await uploadBuffer(thumbnailKey, thumbBuffer, 'image/jpeg')
        }

        await upsertPost({
          fansly_post_id: post.id,
          fansly_media_id: post.media_id ?? null,
          creator_username: post.creator_username,
          creator_fansly_url: `https://fansly.com/${post.creator_username}`,
          caption: post.caption,
          hashtags: post.hashtags,
          likes_initial: post.likes,
          likes_current: post.likes,
          video_r2_key: videoKey,
          thumbnail_r2_key: thumbnailKey,
          video_duration: Math.round(post.duration),
          is_explicit: true,
          post_date: post.post_date,
        })

        added++
        console.log(`  ✨ inserted: @${post.creator_username} (${post.likes} likes)`)
      } catch (err) {
        console.error(`  ❌ Failed to process post ${post.id}:`, err)
        skipped++
      }
    }

    // Enforce per-creator cap: keep only top MAX_POSTS_PER_CREATOR by likes per creator
    const archived = await enforceCreatorCap(MAX_POSTS_PER_CREATOR)
    if (archived > 0) {
      console.log(`  🧹 Archived ${archived} posts (creator cap: ${MAX_POSTS_PER_CREATOR}/creator)`)
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000)
    console.log(`\n✅ Done in ${elapsed}s — added: ${added}, updated: ${updated}, skipped: ${skipped}`)
    await sendTelegram(scraperSuccess(added, updated, skipped))

    // Suggestions are generated on-demand via the UI — not auto-generated after scraping

    process.exit(0)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('💥 Scraper crashed:', msg)
    await sendTelegram(scraperError(msg))
    process.exit(1)
  }
}

main()
