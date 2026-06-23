import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getNextSlot } from '@/lib/scheduling'

export async function POST(request: NextRequest, { params }: { params: Promise<{ username: string }> }) {
  const { username } = await params
  const { post_id, placeholder, duration } = await request.json()
  if (!post_id) return NextResponse.json({ error: 'post_id required' }, { status: 400 })

  // Clamp requested duration between 3 and 15 seconds, default 5
  const durationSeconds = Math.min(15, Math.max(3, typeof duration === 'number' ? Math.round(duration) : 5))

  const [{ data: model }, { data: post }] = await Promise.all([
    supabaseAdmin.from('trends_models').select('id, placeholder_options').ilike('fansly_username', username).single(),
    supabaseAdmin.from('trends_posts').select('text_template').eq('id', post_id).single(),
  ])

  if (!model) return NextResponse.json({ error: 'Model not found' }, { status: 404 })
  if (!post?.text_template) return NextResponse.json({ error: 'Post has no template' }, { status: 400 })

  const options: string[] = model.placeholder_options ?? []
  const randomOption = options.length > 0 ? options[Math.floor(Math.random() * options.length)] : ''
  const chosen = placeholder ?? randomOption
  const personalizedText = post.text_template.replace(/\[placeholder\]/gi, chosen)

  let clipId: string | null = null
  let clipIndex: number | null = null

  const { data: pipelineModel } = await supabaseAdmin
    .from('pipeline_models')
    .select('id')
    .ilike('handle', username)
    .single()

  if (pipelineModel) {
    const [{ data: allFootage }, { count: totalJobCount }, { data: existingModelClips }] = await Promise.all([
      supabaseAdmin.from('pipeline_content_bank').select('id, r2_key, label, trim_end, tags').eq('model_id', pipelineModel.id).order('created_at'),
      supabaseAdmin.from('video_jobs').select('id', { count: 'exact', head: true }).eq('model_id', model.id),
      supabaseAdmin.from('model_clips').select('id, r2_key').eq('model_id', model.id),
    ])

    const footage = allFootage ?? []

    if (footage.length > 0) {
      // Rotate through all clips in order based on total job count for this model.
      // This guarantees clip variety across all generations regardless of which post is being generated.
      const rotationIdx = (totalJobCount ?? 0) % footage.length
      const chosen_footage = footage[rotationIdx]
      clipIndex = rotationIdx + 1

      const r2KeyToClipId = new Map((existingModelClips ?? []).map(mc => [mc.r2_key as string, mc.id as string]))
      const existingClipId = r2KeyToClipId.get(chosen_footage.r2_key)
      if (existingClipId) {
        clipId = existingClipId
      } else {
        const { data: newClip } = await supabaseAdmin
          .from('model_clips')
          .insert({
            model_id: model.id,
            r2_key: chosen_footage.r2_key,
            filename: chosen_footage.label ?? chosen_footage.r2_key.split('/').pop(),
            duration_seconds: chosen_footage.trim_end ?? null,
            tags: chosen_footage.tags ?? [],
          })
          .select('id')
          .single()
        if (newClip) clipId = newClip.id
      }
    }
  }

  const scheduledFor = await getNextSlot(model.id)

  const { data: job, error } = await supabaseAdmin
    .from('video_jobs')
    .insert({
      post_id,
      model_id: model.id,
      clip_id: clipId,
      clip_index: clipIndex,
      duration_seconds: durationSeconds,
      original_template: post.text_template,
      personalized_text: personalizedText,
      status: 'pending',
      scheduled_for: scheduledFor.toISOString(),
    })
    .select('id')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ job_id: job.id, personalized_text: personalizedText })
}
