import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(request: NextRequest, { params }: { params: Promise<{ username: string }> }) {
  const { username } = await params
  const { post_id } = await request.json()
  if (!post_id) return NextResponse.json({ error: 'post_id required' }, { status: 400 })

  const [{ data: model }, { data: post }] = await Promise.all([
    supabaseAdmin.from('trends_models').select('id, branding_file_md').eq('fansly_username', username.toLowerCase()).single(),
    supabaseAdmin.from('trends_posts').select('text_template').eq('id', post_id).single(),
  ])

  if (!model) return NextResponse.json({ error: 'Model not found' }, { status: 404 })
  if (!post?.text_template) return NextResponse.json({ error: 'Post has no template' }, { status: 400 })

  // Personalize text
  let personalizedText = post.text_template
  if (model.branding_file_md) {
    try {
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `You adapt video text overlays for OnlyFans/Fansly creators. Keep the same structure and emotional tone. Only change specific details (age, ethnicity, nationality, personality traits) to match the model's identity. Never change the format — one line per overlay, same number of lines. Never add emojis. Never explain — just output the adapted text.

TEMPLATE:
${post.text_template}

MODEL PROFILE:
${model.branding_file_md.slice(0, 3000)}

Output only the adapted text, same number of lines, nothing else.`,
        }],
      })
      personalizedText = (msg.content[0] as { type: string; text: string }).text.trim()
    } catch { /* fall through to original */ }
  }

  // Get or create a model_clip from pipeline_content_bank own_footage
  let clipId: string | null = null

  const { data: pipelineModel } = await supabaseAdmin
    .from('pipeline_models')
    .select('id')
    .eq('handle', username.toLowerCase())
    .single()

  if (pipelineModel) {
    const { data: footage } = await supabaseAdmin
      .from('pipeline_content_bank')
      .select('id, r2_key, label, trim_end')
      .eq('model_id', pipelineModel.id)
      .eq('type', 'own_footage')
      .order('created_at')
      .limit(1)
      .single()

    if (footage) {
      // Check if already registered as model_clip
      const { data: existing } = await supabaseAdmin
        .from('model_clips')
        .select('id')
        .eq('model_id', model.id)
        .eq('r2_key', footage.r2_key)
        .maybeSingle()

      if (existing) {
        clipId = existing.id
      } else {
        const { data: newClip } = await supabaseAdmin
          .from('model_clips')
          .insert({ model_id: model.id, r2_key: footage.r2_key, filename: footage.label ?? footage.r2_key.split('/').pop(), duration_seconds: footage.trim_end ?? null, tags: [] })
          .select('id')
          .single()
        if (newClip) clipId = newClip.id
      }
    }
  }

  // Create video_job
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
