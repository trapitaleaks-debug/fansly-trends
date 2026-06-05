import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const { data } = await supabaseAdmin
    .from('trends_posts')
    .select('likes_current')
    .gte('scraped_at', cutoff)
    .is('archived_at', null)

  if (!data || data.length === 0) {
    return NextResponse.json({ avgLikes: 0, topLikes: 0, totalPosts: 0 })
  }

  const likes = data.map(r => r.likes_current as number)
  const avgLikes = Math.round(likes.reduce((a, b) => a + b, 0) / likes.length)
  const topLikes = Math.max(...likes)
  const totalPosts = data.length

  return NextResponse.json({ avgLikes, topLikes, totalPosts })
}
