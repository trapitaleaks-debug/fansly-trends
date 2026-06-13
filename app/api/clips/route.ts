import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const model_username = searchParams.get('model')

  let query = supabaseAdmin
    .from('model_clips')
    .select('id, model_id, r2_key, filename, duration_seconds, tags, created_at, trends_models(fansly_username)')
    .order('created_at', { ascending: false })

  if (model_username) {
    const { data: model } = await supabaseAdmin
      .from('trends_models')
      .select('id')
      .eq('fansly_username', model_username.toLowerCase())
      .single()
    if (model) query = query.eq('model_id', model.id)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ clips: data ?? [] })
}

export async function POST(request: NextRequest) {
  const body = await request.json()
  const { model_username, r2_key, filename, duration_seconds, tags } = body
  if (!model_username || !r2_key) return NextResponse.json({ error: 'model_username and r2_key required' }, { status: 400 })

  const { data: model } = await supabaseAdmin
    .from('trends_models')
    .select('id')
    .eq('fansly_username', model_username.toLowerCase())
    .single()
  if (!model) return NextResponse.json({ error: 'Model not found' }, { status: 404 })

  const { data, error } = await supabaseAdmin
    .from('model_clips')
    .insert({ model_id: model.id, r2_key, filename, duration_seconds, tags: tags ?? [] })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ clip: data }, { status: 201 })
}
