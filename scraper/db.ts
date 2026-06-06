import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let _client: SupabaseClient | null = null
export function getClient(): SupabaseClient {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _client
}

export interface PostRecord {
  fansly_post_id: string
  creator_username: string
  creator_fansly_url: string
  caption: string
  hashtags: string[]
  likes_initial: number
  likes_current: number
  video_r2_key: string
  thumbnail_r2_key: string
  video_duration: number
  is_explicit: boolean
  post_date: string | null
}

export async function upsertPost(post: PostRecord): Promise<'inserted' | 'updated'> {
  const { data: existing } = await getClient()
    .from('trends_posts')
    .select('id, likes_initial')
    .eq('fansly_post_id', post.fansly_post_id)
    .single()

  if (existing) {
    const { error: updateError } = await getClient()
      .from('trends_posts')
      .update({ likes_current: post.likes_current, scraped_at: new Date().toISOString() })
      .eq('fansly_post_id', post.fansly_post_id)
    if (updateError) throw new Error(`Update failed: ${updateError.message}`)
    return 'updated'
  }

  const { error: insertError } = await getClient().from('trends_posts').insert({
    ...post,
    scraped_at: new Date().toISOString(),
  })
  if (insertError) throw new Error(`Insert failed: ${insertError.message} (code: ${insertError.code})`)
  return 'inserted'
}

export async function getBlacklist(): Promise<string[]> {
  const { data } = await getClient().from('trends_blacklist').select('username')
  return (data ?? []).map((r: { username: string }) => r.username.toLowerCase())
}

export async function getExistingPostIds(fanslyPostIds: string[]): Promise<Set<string>> {
  if (fanslyPostIds.length === 0) return new Set()
  const { data } = await getClient()
    .from('trends_posts')
    .select('fansly_post_id')
    .in('fansly_post_id', fanslyPostIds)
  return new Set((data ?? []).map((r: { fansly_post_id: string }) => r.fansly_post_id))
}

export async function batchUpdateLikes(updates: { fansly_post_id: string; likes_current: number }[]): Promise<void> {
  if (updates.length === 0) return
  // Parallel batches of 50 — only update likes_current, never scraped_at
  for (let i = 0; i < updates.length; i += 50) {
    const chunk = updates.slice(i, i + 50)
    await Promise.all(chunk.map(u =>
      getClient()
        .from('trends_posts')
        .update({ likes_current: u.likes_current })
        .eq('fansly_post_id', u.fansly_post_id)
    ))
  }
}

export async function getPostsForVelocityCheck(): Promise<{ id: string; fansly_post_id: string; likes_initial: number }[]> {
  const cutoff = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
  const { data } = await getClient()
    .from('trends_posts')
    .select('id, fansly_post_id, likes_initial')
    .gte('scraped_at', cutoff)
    .is('last_velocity_check', null)
  return data ?? []
}

export async function updateVelocity(id: string, likesCurrent: number, likesInitial: number) {
  const growth = likesInitial > 0
    ? parseFloat((((likesCurrent - likesInitial) / likesInitial) * 100).toFixed(2))
    : 0

  await getClient().from('trends_posts').update({
    likes_current: likesCurrent,
    growth_24h_pct: growth,
    last_velocity_check: new Date().toISOString(),
  }).eq('id', id)

  await getClient().from('trends_snapshots').insert({
    post_id: id,
    likes: likesCurrent,
    snapshot_type: '24h',
  })
}
