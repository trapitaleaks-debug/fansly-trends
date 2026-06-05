import 'dotenv/config'
import { chromium } from 'playwright'
import { getPostsForVelocityCheck, updateVelocity } from './db'
import { sendTelegram, velocityDone, scraperError } from '../lib/telegram'

async function getLikesForPost(postId: string): Promise<number | null> {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  let likes: number | null = null

  page.on('response', async response => {
    if (!response.url().includes('fansly.com/api')) return
    try {
      const json = await response.json() as Record<string, unknown>
      const postData = (json.data as Record<string, unknown>) ?? json
      if ((postData.id as string) === postId) {
        const likesData = (postData.likes as Record<string, unknown>) ?? {}
        likes = (likesData.count as number) ?? (postData.likesCount as number) ?? null
      }
    } catch { /* skip */ }
  })

  try {
    await page.goto(`https://fansly.com/post/${postId}`, { waitUntil: 'networkidle', timeout: 15000 })
  } catch { /* timeout ok */ }

  await browser.close()
  return likes
}

async function main() {
  console.log('📊 FanslyTrends velocity check starting...')
  let updated = 0

  try {
    const posts = await getPostsForVelocityCheck()
    console.log(`Found ${posts.length} posts to check`)

    for (const post of posts) {
      const current = await getLikesForPost(post.fansly_post_id)
      if (current === null) {
        console.log(`  ⚠️  Could not get likes for ${post.fansly_post_id}`)
        continue
      }
      await updateVelocity(post.id, current, post.likes_initial)
      updated++
      console.log(`  ✓ ${post.fansly_post_id}: ${post.likes_initial} → ${current} likes`)
    }

    console.log(`\n✅ Velocity check done — ${updated} posts updated`)
    await sendTelegram(velocityDone(updated))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('💥 Velocity check crashed:', msg)
    await sendTelegram(scraperError(`[velocity] ${msg}`))
    process.exit(1)
  }
}

main()
