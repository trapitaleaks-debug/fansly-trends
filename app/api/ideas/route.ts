import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const niche = searchParams.get('niche')

  let query = supabaseAdmin
    .from('trends_ideas')
    .select('*, trends_posts(*)')
    .order('created_at', { ascending: false })

  if (niche) query = query.contains('niches', [niche])

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ideas: data })
}

export async function POST(request: NextRequest) {
  const body = await request.json()
  const { post_id, niches, notes } = body
  if (!post_id) return NextResponse.json({ error: 'post_id required' }, { status: 400 })

  // Check if already bookmarked
  const { data: existing } = await supabaseAdmin
    .from('trends_ideas')
    .select('id')
    .eq('post_id', post_id)
    .single()

  if (existing) {
    // Update niches on existing bookmark
    const { data, error } = await supabaseAdmin
      .from('trends_ideas')
      .update({ niches: niches ?? [], notes: notes ?? '', updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ idea: data, updated: true })
  }

  const { data, error } = await supabaseAdmin
    .from('trends_ideas')
    .insert({ post_id, niches: niches ?? [], tags: [], notes: notes ?? '' })
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ idea: data })
}
