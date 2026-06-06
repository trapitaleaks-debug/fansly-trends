import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const sort = searchParams.get('sort') ?? 'trending'
  const days = parseInt(searchParams.get('days') ?? '7')
  const minLikes = parseInt(searchParams.get('minLikes') ?? '0')
  const hashtag = searchParams.get('hashtag') ?? ''
  const type = searchParams.get('type') ?? 'all' // all | explicit | sfw
  const page = parseInt(searchParams.get('page') ?? '0')
  const limit = 30

  let query = supabaseAdmin
    .from('trends_posts')
    .select('*, trends_ideas(id, folder, tags, notes)')
    .is('archived_at', null)
    .gte('likes_current', 150) // always enforce minimum quality floor
    .not('video_r2_key', 'is', null)
    .neq('video_r2_key', '')

  if (days > 0) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    query = query.gte('scraped_at', cutoff)
  }
  if (minLikes > 0) query = query.gte('likes_current', minLikes)
  if (hashtag) query = query.contains('hashtags', [hashtag.replace('#', '')])
  if (type === 'explicit') query = query.eq('is_explicit', true)
  if (type === 'sfw') query = query.eq('is_explicit', false)

  if (sort === 'trending') query = query.order('likes_current', { ascending: false })
  else if (sort === 'liked') query = query.order('likes_current', { ascending: false })
  else query = query.order('scraped_at', { ascending: false })

  query = query.range(page * limit, (page + 1) * limit - 1)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ posts: data })
}
