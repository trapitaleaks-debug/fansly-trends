import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')

  let query = supabaseAdmin
    .from('video_jobs')
    .select(`
      id, post_id, model_id, clip_id, personalized_text, status, created_at, updated_at,
      output_r2_key, thumbnail_r2_key, error_message, post_fail_count, failure_kind, needs_review, diagnosis,
      trends_models(fansly_username),
      trends_posts(creator_username, thumbnail_r2_key)
    `)
    .order('created_at', { ascending: false })

  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ jobs: data ?? [] })
}

export async function POST(request: NextRequest) {
  const body = await request.json()
  const { post_id, model_username, clip_id, personalized_text, original_template } = body
  if (!post_id || !model_username || !original_template) {
    return NextResponse.json({ error: 'post_id, model_username, original_template required' }, { status: 400 })
  }

  const { data: model } = await supabaseAdmin
    .from('trends_models')
    .select('id')
    .eq('fansly_username', model_username.toLowerCase())
    .single()
  if (!model) return NextResponse.json({ error: 'Model not found' }, { status: 404 })

  const { data, error } = await supabaseAdmin
    .from('video_jobs')
    .insert({
      post_id,
      model_id: model.id,
      clip_id: clip_id ?? null,
      original_template,
      personalized_text: personalized_text ?? null,
      status: 'pending',
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ job: data }, { status: 201 })
}
