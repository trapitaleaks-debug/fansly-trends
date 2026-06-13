import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('trends_posts')
    .select('id, caption, hashtags, likes_current, post_date, creator_username, text_template, thumbnail_r2_key')
    .not('text_template', 'is', null)
    .order('likes_current', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ templates: data ?? [] })
}
