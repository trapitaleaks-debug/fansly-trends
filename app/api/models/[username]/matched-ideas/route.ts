import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ username: string }> }) {
  const { username } = await params

  // Get model's niches
  const { data: model } = await supabaseAdmin
    .from('trends_models')
    .select('niches')
    .ilike('fansly_username', username)
    .single()

  if (!model || !model.niches?.length) {
    return NextResponse.json({ ideas: [] })
  }

  // Collect model's content bank tag set (via pipeline_models.handle)
  const { data: pipelineModel } = await supabaseAdmin
    .from('pipeline_models')
    .select('id')
    .ilike('handle', username)
    .maybeSingle()

  const contentBankTags = new Set<string>()
  if (pipelineModel) {
    const { data: bankItems } = await supabaseAdmin
      .from('pipeline_content_bank')
      .select('tags')
      .eq('model_id', pipelineModel.id)
    for (const item of bankItems ?? []) {
      for (const t of (item.tags ?? []) as string[]) contentBankTags.add(t)
    }
  }

  // Fetch all ideas; filter those sharing at least one niche with the model
  const { data: ideas, error } = await supabaseAdmin
    .from('trends_ideas')
    .select('*, trends_posts(*, video_jobs(id, status, model_id, output_r2_key, thumbnail_r2_key, personalized_text, clip_id, clip_index, duration_seconds, model_clips(id, filename)))')
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const modelNiches = new Set(model.niches)
  const matched = (ideas ?? [])
    .filter((idea: { niches: string[] }) =>
      (idea.niches ?? []).some((n: string) => modelNiches.has(n))
    )
    .filter((idea: { tags: string[] }) => {
      // If model has no tagged content bank clips, skip tag filter (show all niche-matched ideas)
      if (contentBankTags.size === 0) return true
      return (idea.tags ?? []).some((t: string) => contentBankTags.has(t))
    })

  return NextResponse.json({ ideas: matched, modelNiches: model.niches })
}
