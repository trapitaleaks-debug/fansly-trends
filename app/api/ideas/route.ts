import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const folder = searchParams.get('folder')

  let query = supabaseAdmin
    .from('trends_ideas')
    .select('*, trends_posts(*)')
    .order('created_at', { ascending: false })

  if (folder) query = query.eq('folder', folder)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ideas: data })
}

export async function POST(request: NextRequest) {
  const body = await request.json()
  const { post_id, folder, tags, notes } = body
  if (!post_id) return NextResponse.json({ error: 'post_id required' }, { status: 400 })
  const { data, error } = await supabaseAdmin
    .from('trends_ideas')
    .insert({ post_id, folder: folder ?? null, tags: tags ?? [], notes: notes ?? '' })
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ idea: data })
}
