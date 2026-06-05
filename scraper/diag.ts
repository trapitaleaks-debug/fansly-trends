import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.join(__dirname, '../.env.local') })
import * as fs from 'fs'

// Quick diagnostic: collect 20 batches via cursor pagination and show likes distribution
// Uses saved auth headers from discover.ts run (tmp/auth_headers.json)

async function main() {
  const headersPath = path.join(__dirname, '../tmp/auth_headers.json')
  const postsPath = path.join(__dirname, '../tmp/all_posts.json')

  if (!fs.existsSync(headersPath)) {
    console.error('❌ Run discover.ts first to capture auth headers (tmp/auth_headers.json)')
    process.exit(1)
  }

  const capturedHeaders = JSON.parse(fs.readFileSync(headersPath, 'utf-8')) as Record<string, string>
  const allPosts: Record<string, unknown>[] = fs.existsSync(postsPath)
    ? JSON.parse(fs.readFileSync(postsPath, 'utf-8')) as Record<string, unknown>[]
    : []

  const seenIds = new Set(allPosts.map(p => String(p.id)))
  console.log(`📦 Starting with ${allPosts.length} posts from browser session`)

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

  const N_BATCHES = 30
  let lastId = allPosts.length > 0 ? String(allPosts[allPosts.length - 1].id) : '0'

  for (let batch = 1; batch <= N_BATCHES; batch++) {
    const url = `https://apiv3.fansly.com/api/v1/timeline/home?before=${lastId}&after=0&mode=0&ngsw-bypass=true`
    const res = await fetch(url, { headers: { ...reqHeaders, 'fansly-client-ts': Date.now().toString() } })

    if (res.status === 429) {
      console.log('  ⏳ Rate limited — waiting 65s...')
      await new Promise(r => setTimeout(r, 65000))
      continue
    }
    if (!res.ok) {
      console.log(`  ❌ HTTP ${res.status} at batch ${batch}`)
      break
    }

    const json = await res.json() as Record<string, unknown>
    const resp = (json.response ?? json) as Record<string, unknown>
    const posts = (resp.posts ?? []) as Record<string, unknown>[]

    let newPosts = 0
    for (const p of posts) {
      const id = String(p.id)
      if (!seenIds.has(id)) {
        seenIds.add(id)
        allPosts.push(p)
        newPosts++
      }
    }

    if (posts.length > 0) lastId = String(posts[posts.length - 1].id)

    // Show likes distribution for this batch
    const batchLikes = posts.map(p => Math.max(Number(p.likeCount ?? 0), Number(p.mediaLikeCount ?? 0)))
    const above150 = batchLikes.filter(l => l >= 150).length
    const above50 = batchLikes.filter(l => l >= 50).length
    const maxLike = Math.max(...batchLikes, 0)
    console.log(`  Batch ${batch}: ${newPosts} new, max=${maxLike}, ≥150: ${above150}/${posts.length}, ≥50: ${above50}/${posts.length}`)

    await new Promise(r => setTimeout(r, 1200))
  }

  // Overall distribution
  const allLikes = allPosts.map(p => Math.max(Number(p.likeCount ?? 0), Number(p.mediaLikeCount ?? 0)))
  const above150 = allLikes.filter(l => l >= 150).length
  const above100 = allLikes.filter(l => l >= 100).length
  const above50 = allLikes.filter(l => l >= 50).length
  const above10 = allLikes.filter(l => l >= 10).length

  console.log(`\n📊 Distribution across ${allPosts.length} total posts:`)
  console.log(`  ≥150 likes: ${above150} (${(above150/allPosts.length*100).toFixed(1)}%)`)
  console.log(`  ≥100 likes: ${above100} (${(above100/allPosts.length*100).toFixed(1)}%)`)
  console.log(`  ≥50 likes:  ${above50} (${(above50/allPosts.length*100).toFixed(1)}%)`)
  console.log(`  ≥10 likes:  ${above10} (${(above10/allPosts.length*100).toFixed(1)}%)`)
  console.log(`  Top 20 likes: ${allLikes.sort((a,b)=>b-a).slice(0,20).join(', ')}`)

  // Also check video-only posts
  const videoPosts = allPosts.filter(p => {
    const attachments = Array.isArray(p.attachments) ? p.attachments as Record<string,unknown>[] : []
    return attachments.length > 0  // rough proxy for has-media
  })
  const videoLikes = videoPosts.map(p => Math.max(Number(p.likeCount ?? 0), Number(p.mediaLikeCount ?? 0)))
  const videoAbove150 = videoLikes.filter(l => l >= 150).length
  console.log(`\n  Media posts: ${videoPosts.length}, ≥150 likes: ${videoAbove150}`)

  fs.writeFileSync(path.join(__dirname, '../tmp/diag_posts.json'), JSON.stringify(allPosts, null, 2))
  console.log('\n💾 Saved to tmp/diag_posts.json')
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1) })
