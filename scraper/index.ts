import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.join(__dirname, '../.env.local') })
import { scrapeFYP } from './fansly'
import { uploadBuffer, downloadUrl } from './storage'
import { upsertPost, getBlacklist } from './db'
import { sendTelegram, scraperSuccess, scraperError } from '../lib/telegram'

const MIN_LIKES = 150
const TARGET_COUNT = 100
// Collect far more raw posts than needed; most won't hit MIN_LIKES threshold
const RAW_COLLECT = 4000

async function main() {
  console.log('🚀 FanslyTrends scraper starting...')

  let added = 0, updated = 0, skipped = 0

  try {
    const blacklist = await getBlacklist()
    console.log(`📋 Blacklist loaded: ${blacklist.length} usernames`)

    const posts = await scrapeFYP(RAW_COLLECT)
    console.log(`\n📦 Processing ${posts.length} collected posts...`)

    for (const post of posts) {
      if (added >= TARGET_COUNT) { skipped++; continue } // stop once we have enough
      // filters
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

        if (post.thumbnail_url) {
          if (!post.thumbnail_url.startsWith('http')) {
            // skip relative thumbnail silently
          } else {
            thumbnailKey = `thumbs/${post.id}.jpg`
            const thumbBuffer = await downloadUrl(post.thumbnail_url)
            await uploadBuffer(thumbnailKey, thumbBuffer, 'image/jpeg')
          }
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
