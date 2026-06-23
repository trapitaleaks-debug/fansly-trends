/**
 * Targeted feet-hashtag scraper.
 * Logs in with all accounts, then hammers the feet tag list with more pages per tag.
 */
import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.join(__dirname, '../.env.local') })
import { scrapeFYP, type AccountConfig, type FanslyPost } from './fansly'
import { scrapeHashtagList } from './hashtag'
import { uploadBuffer, downloadUrl } from './storage'
import { upsertPost, getBlacklist, getExistingPostIds, getExistingMediaIds, batchUpdateLikes, enforceCreatorCap } from './db'
import { sendTelegram, scraperSuccess, scraperError } from '../lib/telegram'

const MIN_LIKES = 100
const TARGET_COUNT = 4000
const PAGES_PER_TAG = 30         // more pages than normal run (12)
const MIN_POSTS_PER_ACCOUNT = 800
const MAX_POSTS_PER_CREATOR = 50

const FEET_TAGS = [
  'feet', 'footfetish', 'feetfetish', 'soles', 'toes',
  'foot', 'footworship', 'heels', 'highheels', 'footjob',
]

function loadAccounts(): AccountConfig[] {
  if (process.env.FANSLY_ACCOUNTS) {
    try { return JSON.parse(process.env.FANSLY_ACCOUNTS) as AccountConfig[] } catch { /* */ }
  }
  return [{ email: process.env.FANSLY_EMAIL!, password: process.env.FANSLY_PASSWORD!, totpKey: process.env.FANSLY_TOTP_KEY! }]
}

async function main() {
  console.log('🦶 Feet-targeted scraper starting...')
  console.log(`   Tags: ${FEET_TAGS.join(', ')}`)
  const startTime = Date.now()
  let added = 0, updated = 0, skipped = 0

  try {
    const blacklist = await getBlacklist()
    const accounts = loadAccounts()
    console.log(`👥 Accounts: ${accounts.length}`)

    const postMap = new Map<string, FanslyPost>()
    const accountHeaders: Array<{ email: string; headers: Record<string, string> }> = []

    // Login all accounts to get auth headers (skip FYP scroll — just need headers)
    console.log('\n--- Logging in all accounts ---')
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i]
      console.log(`\n📡 Account ${i + 1}/${accounts.length}: ${acc.email}`)
      try {
        const { headers } = await scrapeFYP(1, acc)  // minimal FYP = just enough to get headers
        if (Object.keys(headers).length > 0) {
          accountHeaders.push({ email: acc.email, headers })
          console.log(`  ✅ Auth headers captured`)
        }
      } catch (err) {
        console.error(`  ❌ ${acc.email} failed:`, err instanceof Error ? err.message : err)
      }
    }

    if (accountHeaders.length === 0) throw new Error('No accounts authenticated')

    // Distribute feet tags across accounts
    console.log(`\n--- Scraping ${FEET_TAGS.length} feet tags across ${accountHeaders.length} accounts (${PAGES_PER_TAG} pages/tag) ---`)
    const chunkSize = Math.ceil(FEET_TAGS.length / accountHeaders.length)

    for (let i = 0; i < accountHeaders.length; i++) {
      const { email, headers } = accountHeaders[i]
      const tagSlice = FEET_TAGS.slice(i * chunkSize, (i + 1) * chunkSize)
      if (tagSlice.length === 0) continue
      console.log(`\n  📡 Account ${i + 1} (${email}): ${tagSlice.join(', ')}`)
      try {
        const posts = await scrapeHashtagList(headers, tagSlice, PAGES_PER_TAG, MIN_POSTS_PER_ACCOUNT)
        let fresh = 0
        for (const p of posts) {
          if (!p.id) continue
          const existing = postMap.get(p.id)
          if (!existing || p.likes > existing.likes) { postMap.set(p.id, p); if (!existing) fresh++ }
        }
        console.log(`  ✅ +${fresh} fresh (${postMap.size} total)`)
      } catch (err) {
        console.error(`  ❌ Failed:`, err instanceof Error ? err.message : err)
      }
    }

    // Phase 3: filter + save
    const qualifying = Array.from(postMap.values())
      .filter(p => p.id && p.is_video && p.video_url && p.likes >= MIN_LIKES && !blacklist.includes(p.creator_username.toLowerCase()))
      .sort((a, b) => b.likes - a.likes)

    const seenMedia = new Set<string>()
    const allPosts = qualifying.filter(p => {
      if (!p.media_id) return true
      if (seenMedia.has(p.media_id)) return false
      seenMedia.add(p.media_id); return true
    })

    console.log(`\n--- Processing ${allPosts.length} qualifying posts (≥${MIN_LIKES} likes) ---`)

    const existingIds = await getExistingPostIds(allPosts.map(p => p.id))
    const existingMediaIds = await getExistingMediaIds(allPosts.map(p => p.media_id ?? '').filter(Boolean))

    const existingPosts = allPosts.filter(p => existingIds.has(p.id))
    if (existingPosts.length > 0) {
      await batchUpdateLikes(existingPosts.map(p => ({ fansly_post_id: p.id, likes_current: p.likes })))
      updated = existingPosts.length
      console.log(`  🔄 Updated likes for ${updated} existing posts`)
    }

    const newPosts = allPosts.filter(p => !existingIds.has(p.id) && !(p.media_id && existingMediaIds.has(p.media_id)))
    console.log(`  📦 ${existingIds.size} already in DB, ${newPosts.length} new`)

    for (const post of newPosts) {
      if (added >= TARGET_COUNT) { skipped++; continue }
      try {
        let videoKey = ''
        let thumbnailKey = ''
        if (post.video_url?.startsWith('http')) {
          videoKey = `videos/${post.id}.mp4`
          await uploadBuffer(videoKey, await downloadUrl(post.video_url), 'video/mp4')
        }
        if (post.thumbnail_url?.startsWith('http')) {
          thumbnailKey = `thumbs/${post.id}.jpg`
          await uploadBuffer(thumbnailKey, await downloadUrl(post.thumbnail_url), 'image/jpeg')
        }
        await upsertPost({
          fansly_post_id: post.id, fansly_media_id: post.media_id ?? null,
          creator_username: post.creator_username, creator_fansly_url: `https://fansly.com/${post.creator_username}`,
          caption: post.caption, hashtags: post.hashtags,
          likes_initial: post.likes, likes_current: post.likes,
          video_r2_key: videoKey, thumbnail_r2_key: thumbnailKey,
          video_duration: Math.round(post.duration), is_explicit: true, post_date: post.post_date,
        })
        added++
        console.log(`  ✨ inserted: @${post.creator_username} (${post.likes} likes)`)
      } catch (err) {
        console.error(`  ❌ Failed post ${post.id}:`, err); skipped++
      }
    }

    const archived = await enforceCreatorCap(MAX_POSTS_PER_CREATOR)
    if (archived > 0) console.log(`  🧹 Archived ${archived} posts (creator cap)`)

    const elapsed = Math.round((Date.now() - startTime) / 1000)
    console.log(`\n✅ Done in ${elapsed}s — added: ${added}, updated: ${updated}, skipped: ${skipped}`)
    await sendTelegram(scraperSuccess(added, updated, skipped, { accountsOk: accountHeaders.length, accountsFailed: accounts.length - accountHeaders.length, phase1Posts: 0, authHeaders: accountHeaders.length }))
    process.exit(0)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('💥 Scraper crashed:', msg)
    await sendTelegram(scraperError(msg))
    process.exit(1)
  }
}

main()
