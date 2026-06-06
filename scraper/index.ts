import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.join(__dirname, '../.env.local') })
import { scrapeFYP, type AccountConfig, type FanslyPost } from './fansly'
import { scrapeHashtags } from './hashtag'
import { uploadBuffer, downloadUrl } from './storage'
import { upsertPost, getBlacklist } from './db'
import { sendTelegram, scraperSuccess, scraperError } from '../lib/telegram'

const MIN_LIKES = 150
const TARGET_COUNT = 2000
const RAW_COLLECT_PER_ACCOUNT = 2000
const HASHTAG_TOP_N = 100
const HASHTAG_PAGES_PER_TAG = 10 // 10 pages × 10 items = 100 items per hashtag

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
      console.log('\n--- Phase 2: Hashtag scraping (top 100 tags) ---')
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
    const allPosts = Array.from(postMap.values()).sort((a, b) => b.likes - a.likes)
    console.log(`\n--- Phase 3: Processing ${allPosts.length} unique posts (sorted by likes) ---`)

    for (const post of allPosts) {
      if (added >= TARGET_COUNT) { skipped++; continue }
      if (!post.is_video) { skipped++; continue }
      if (post.likes < MIN_LIKES) { skipped++; continue }
      if (blacklist.includes(post.creator_username.toLowerCase())) { skipped++; continue }
      if (!post.id) { skipped++; continue }

      try {
        let videoKey = ''
        let thumbnailKey = ''

        if (post.video_url) {
          if (!post.video_url.startsWith('http')) {
            console.warn(`  ⚠️  Relative video URL for ${post.id}, skipping upload`)
          } else {
            videoKey = `videos/${post.id}.mp4`
            const videoBuffer = await downloadUrl(post.video_url)
            await uploadBuffer(videoKey, videoBuffer, 'video/mp4')
          }
        }

        if (post.thumbnail_url && post.thumbnail_url.startsWith('http')) {
          thumbnailKey = `thumbs/${post.id}.jpg`
          const thumbBuffer = await downloadUrl(post.thumbnail_url)
          await uploadBuffer(thumbnailKey, thumbBuffer, 'image/jpeg')
        }

        const result = await upsertPost({
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

        if (result === 'inserted') added++
        else updated++

        console.log(`  ${result === 'inserted' ? '✨' : '🔄'} ${result}: @${post.creator_username} (${post.likes} likes)`)
      } catch (err) {
        console.error(`  ❌ Failed to process post ${post.id}:`, err)
        skipped++
      }
    }

    console.log(`\n✅ Done — added: ${added}, updated: ${updated}, skipped: ${skipped}`)
    await sendTelegram(scraperSuccess(added, updated, skipped))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('💥 Scraper crashed:', msg)
    await sendTelegram(scraperError(msg))
    process.exit(1)
  }
}

main()
