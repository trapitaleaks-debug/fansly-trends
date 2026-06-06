import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.join(__dirname, '../.env.local') })
import { scrapeFYP, type AccountConfig, type FanslyPost } from './fansly'
import { scrapeHashtags } from './hashtag'
import { uploadBuffer, downloadUrl } from './storage'
import { upsertPost, getBlacklist, getExistingPostIds, batchUpdateLikes } from './db'
import { sendTelegram, scraperSuccess, scraperError } from '../lib/telegram'

const MIN_LIKES = 150
const TARGET_COUNT = 2000
const RAW_COLLECT_PER_ACCOUNT = 300  // reduced: faster per-account, still diverse
const HASHTAG_TOP_N = 30             // top 30 trending tags
const HASHTAG_PAGES_PER_TAG = 5      // 5 pages × 10 items = 50 per tag

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
    let firstAccountHeaders: Record<string, string> = {}

    // Phase 1: FYP scraping across all accounts
    console.log('\n--- Phase 1: FYP scraping ---')
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i]
      console.log(`\n📡 Account ${i + 1}/${accounts.length}: ${acc.email}`)
      try {
        const { posts, headers } = await scrapeFYP(RAW_COLLECT_PER_ACCOUNT, acc)
        if (i === 0 && Object.keys(headers).length > 0) firstAccountHeaders = headers
        let fresh = 0
        for (const p of posts) {
          if (!p.id) continue
          const existing = postMap.get(p.id)
          if (!existing || p.likes > existing.likes) {
            postMap.set(p.id, p)
            if (!existing) fresh++
          }
        }
        console.log(`  +${fresh} unique posts (${postMap.size} total so far)`)
      } catch (err) {
        console.error(`  ❌ Account ${acc.email} failed:`, err instanceof Error ? err.message : err)
      }
    }

    // Phase 2: Hashtag scraping using first account's captured headers
    if (Object.keys(firstAccountHeaders).length > 0) {
      console.log(`\n--- Phase 2: Hashtag scraping (top ${HASHTAG_TOP_N} tags) ---`)
      try {
        const hashtagPosts = await scrapeHashtags(firstAccountHeaders, HASHTAG_TOP_N, HASHTAG_PAGES_PER_TAG)
        let hashtagFresh = 0
        for (const p of hashtagPosts) {
          if (!p.id) continue
          const existing = postMap.get(p.id)
          if (!existing || p.likes > existing.likes) {
            postMap.set(p.id, p)
            if (!existing) hashtagFresh++
          }
        }
        console.log(`\n🏷️  Hashtag scrape added ${hashtagFresh} new unique posts (total: ${postMap.size})`)
      } catch (err) {
        console.error('  ❌ Hashtag scraping failed:', err instanceof Error ? err.message : err)
      }
    } else {
      console.log('\n⚠️  No auth headers captured — skipping hashtag scraping')
    }

    // Phase 3: Process and save qualifying posts
    const allPosts = Array.from(postMap.values())
      .filter(p => p.id && p.is_video && p.video_url && p.likes >= MIN_LIKES && !blacklist.includes(p.creator_username.toLowerCase()))
      .sort((a, b) => b.likes - a.likes)

    console.log(`\n--- Phase 3: Processing ${allPosts.length} qualifying posts (≥${MIN_LIKES} likes, videos only) ---`)

    // Load all existing post IDs in one DB call — skip re-downloads for them
    const allPostIds = allPosts.map(p => p.id)
    const existingIds = await getExistingPostIds(allPostIds)
    console.log(`  📦 ${existingIds.size} already in DB, ${allPosts.length - existingIds.size} new`)

    // Batch-update likes for existing posts (one DB call, no downloads)
    const existingPosts = allPosts.filter(p => existingIds.has(p.id))
    if (existingPosts.length > 0) {
      await batchUpdateLikes(existingPosts.map(p => ({ fansly_post_id: p.id, likes_current: p.likes })))
      updated = existingPosts.length
      console.log(`  🔄 Batch-updated likes for ${updated} existing posts`)
    }

    // Download + upload + insert only for genuinely new posts
    const newPosts = allPosts.filter(p => !existingIds.has(p.id))
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

    const elapsed = Math.round((Date.now() - startTime) / 1000)
    console.log(`\n✅ Done in ${elapsed}s — added: ${added}, updated: ${updated}, skipped: ${skipped}`)
    await sendTelegram(scraperSuccess(added, updated, skipped))
    process.exit(0)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('💥 Scraper crashed:', msg)
    await sendTelegram(scraperError(msg))
    process.exit(1)
  }
}

main()
