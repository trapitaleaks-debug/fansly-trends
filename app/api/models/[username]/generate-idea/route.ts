import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function POST(request: NextRequest, { params }: { params: Promise<{ username: string }> }) {
  const { username } = await params
  const { post_id, placeholder } = await request.json()
  if (!post_id) return NextResponse.json({ error: 'post_id required' }, { status: 400 })

  const [{ data: model }, { data: post }, { data: idea }] = await Promise.all([
    supabaseAdmin.from('trends_models').select('id, placeholder_options').eq('fansly_username', username.toLowerCase()).single(),
    supabaseAdmin.from('trends_posts').select('text_template').eq('id', post_id).single(),
    supabaseAdmin.from('trends_ideas').select('id, tags').eq('post_id', post_id).maybeSingle(),
  ])

  if (!model) return NextResponse.json({ error: 'Model not found' }, { status: 404 })
  if (!post?.text_template) return NextResponse.json({ error: 'Post has no template' }, { status: 400 })

  // Replace [placeholder] with chosen option (caller can pass explicit placeholder, otherwise use first option)
  const options: string[] = model.placeholder_options ?? []
  const chosen = placeholder ?? options[0] ?? ''
  const personalizedText = post.text_template.replace(/\[placeholder\]/gi, chosen)

  // Pick clip from content bank, preferring one matching the idea's tags
  let clipId: string | null = null
  const ideaTags: string[] = idea?.tags ?? []

  const { data: pipelineModel } = await supabaseAdmin
    .from('pipeline_models')
    .select('id')
    .eq('handle', username.toLowerCase())
    .single()

  if (pipelineModel) {
    const { data: allFootage } = await supabaseAdmin
      .from('pipeline_content_bank')
      .select('id, r2_key, label, trim_end, tags')
      .eq('model_id', pipelineModel.id)
      .order('created_at')

    const footage = allFootage ?? []

    // Find best clip: prefer one whose tags overlap with idea tags; fall back to "all"-tagged or first
    const tagged = ideaTags.length > 0 && !ideaTags.includes('all')
      ? footage.find(f => (f.tags ?? []).some((t: string) => ideaTags.includes(t)))
      : null
    const allTagged = footage.find(f => (f.tags ?? []).includes('all'))
    const chosen_footage = tagged ?? allTagged ?? footage[0] ?? null

    if (chosen_footage) {
      const { data: existing } = await supabaseAdmin
        .from('model_clips')
        .select('id')
        .eq('model_id', model.id)
        .eq('r2_key', chosen_footage.r2_key)
        .maybeSingle()

      if (existing) {
        clipId = existing.id
      } else {
        const { data: newClip } = await supabaseAdmin
          .from('model_clips')
          .insert({ model_id: model.id, r2_key: chosen_footage.r2_key, filename: chosen_footage.label ?? chosen_footage.r2_key.split('/').pop(), duration_seconds: chosen_footage.trim_end ?? null, tags: chosen_footage.tags ?? [] })
          .select('id')
          .single()
        if (newClip) clipId = newClip.id
      }
    }
  }

  const { data: job, error } = await supabaseAdmin
    .from('video_jobs')
    .insert({
      post_id,
      model_id: model.id,
      clip_id: clipId,
      original_template: post.text_template,
      personalized_text: personalizedText,
      status: 'pending',
    })
    .select('id')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ job_id: job.id, personalized_text: personalizedText })
}
