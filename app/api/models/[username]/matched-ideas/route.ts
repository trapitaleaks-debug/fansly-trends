import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ username: string }> }) {
  const { username } = await params

  // Get model's niches
  const { data: model } = await supabaseAdmin
    .from('trends_models')
    .select('niches')
    .eq('fansly_username', username.toLowerCase())
    .single()

  if (!model || !model.niches?.length) {
    return NextResponse.json({ ideas: [] })
  }

  // Fetch all ideas; filter those sharing at least one niche with the model
  const { data: ideas, error } = await supabaseAdmin
    .from('trends_ideas')
    .select('*, trends_posts(*, video_jobs(id, status, model_id, output_r2_key, thumbnail_r2_key, personalized_text, clip_id, model_clips(id, filename)))')
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const modelNiches = new Set(model.niches)
  const matched = (ideas ?? []).filter((idea: { niches: string[] }) =>
    (idea.niches ?? []).some((n: string) => modelNiches.has(n))
  )

  return NextResponse.json({ ideas: matched, modelNiches: model.niches })
}
