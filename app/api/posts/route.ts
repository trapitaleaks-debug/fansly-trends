import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const sort = searchParams.get('sort') ?? 'trending'
  const days = parseInt(searchParams.get('days') ?? '7')
  const minLikes = parseInt(searchParams.get('minLikes') ?? '0')
  const hashtag = searchParams.get('hashtag') ?? ''
  const type = searchParams.get('type') ?? 'all' // all | explicit | sfw
  const niche = searchParams.get('niche') ?? '' // e.g. 'asian', 'general', 'teen'
  const tagged = searchParams.get('tagged') // 'yes' = only tagged posts
  const hideBookmarked = searchParams.get('hide_bookmarked') === 'yes'
  const page = parseInt(searchParams.get('page') ?? '0')
  const limit = 30

  let query = supabaseAdmin
    .from('trends_posts')
    .select('*, trends_ideas(id, niches, tags, notes)')
    .is('archived_at', null)
    .gte('likes_current', 150) // always enforce minimum quality floor
    .not('video_r2_key', 'is', null)
    .neq('video_r2_key', '')
    .not('hashtags', 'ov', '{deepthroat,porn,creampie,hotwife,bigdick,breeding,analcreampie,sex,bbc,bwc,bigcock,hugecock,hugedick,swingers,couple,couples,wifesharing,wifeswap,blacked,monstercock,gangbang,cumslut,analsex,cumeating,fuck,bg,sextape,standingfuck}')

  if (days > 0) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    query = query.gte('scraped_at', cutoff)
  }
  if (minLikes > 0) query = query.gte('likes_current', minLikes)
  if (hashtag) query = query.contains('hashtags', [hashtag.replace('#', '')])
  if (type === 'explicit') query = query.eq('is_explicit', true)
  if (type === 'sfw') query = query.eq('is_explicit', false)
  if (niche) query = query.contains('niche_tags', [niche])
  if (tagged === 'yes') query = query.not('niche_tags', 'eq', '{}')
  if (hideBookmarked) {
    const { data: bookmarked } = await supabaseAdmin.from('trends_ideas').select('post_id')
    const ids = bookmarked?.map(b => b.post_id) ?? []
    if (ids.length > 0) query = query.not('id', 'in', `(${ids.join(',')})`)
  }

  if (sort === 'trending') query = query.order('likes_current', { ascending: false })
  else if (sort === 'liked') query = query.order('likes_current', { ascending: false })
  else query = query.order('scraped_at', { ascending: false })

  query = query.range(page * limit, (page + 1) * limit - 1)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ posts: data })
}
