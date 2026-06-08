import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

type Params = { params: Promise<{ username: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const { username } = await params
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status') ?? 'pending'
  const sort = searchParams.get('sort') ?? 'score'
  const page = parseInt(searchParams.get('page') ?? '0')
  const limit = 30

  const { data: model } = await supabaseAdmin
    .from('trends_models')
    .select('id')
    .eq('fansly_username', username.toLowerCase())
    .single()

  if (!model) return NextResponse.json({ error: 'Model not found' }, { status: 404 })

  const { data, error } = await supabaseAdmin
    .from('trends_suggestions')
    .select(`
      id, reasoning, branding_section, what_to_change, status, notes, dismiss_reason, generated_at,
      score_hook, score_replayability, score_retention, score_payoff,
      score_video_quality, score_sexuality, score_text_captions, score_background, score_total,
      trends_posts(id, fansly_post_id, creator_username, creator_fansly_url, likes_current, thumbnail_r2_key, caption, hashtags)
    `)
    .eq('model_id', model.id)
    .eq('status', status)
    .order(sort === 'score' ? 'score_total' : 'generated_at', { ascending: false, nullsFirst: false })
    .range(page * limit, (page + 1) * limit - 1)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ suggestions: data ?? [], hasMore: (data?.length ?? 0) === limit })
}
