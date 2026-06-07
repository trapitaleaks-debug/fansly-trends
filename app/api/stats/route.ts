import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabaseAdmin.rpc('get_trends_stats', { cutoff_ts: cutoff })

  if (error || !data) {
    return NextResponse.json({ avgLikes: 0, topLikes: 0, totalPosts: 0 })
  }

  return NextResponse.json(data)
}
