import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { insertVideoJobWithSlot } from '@/lib/scheduling'
import { clipUsageMap, pickFromUsage } from '@/lib/footage'
import { pickTemplate, resolveMemeText } from '@/lib/template-select'

export async function POST(request: NextRequest, { params }: { params: Promise<{ username: string }> }) {
  const { username } = await params
  const { post_id, placeholder, duration, template_id } = await request.json()
  if (!post_id) return NextResponse.json({ error: 'post_id required' }, { status: 400 })

  // Clamp requested duration between 3 and 15 seconds, default 5
  let durationSeconds = Math.min(15, Math.max(3, typeof duration === 'number' ? Math.round(duration) : 5))

  const [{ data: model }, { data: post }] = await Promise.all([
    supabaseAdmin.from('trends_models').select('id, placeholder_options, niches').ilike('fansly_username', username).single(),
    supabaseAdmin.from('trends_posts').select('text_template, trends_ideas(tags)').eq('id', post_id).single(),
  ])

  if (!model) return NextResponse.json({ error: 'Model not found' }, { status: 404 })
  if (!post?.text_template) return NextResponse.json({ error: 'Post has no template' }, { status: 400 })

  // Template selection: 'auto' = the same weighted two-stage pick used by fill-gaps;
  // a uuid forces a specific template; null/absent = classic layout.
  let memeFixedLines: string[] | null = null
  let resolvedTemplateId: string | null = null
  if (template_id === 'auto') {
    const rawIdea = (post as { trends_ideas?: unknown }).trends_ideas
    const idea = (Array.isArray(rawIdea) ? rawIdea[0] : rawIdea) as { tags?: string[] } | undefined
    const pick = await pickTemplate(idea?.tags ?? [], (model as { niches?: string[] }).niches ?? [])
    resolvedTemplateId = pick.templateId
    if (pick.durationSec) durationSeconds = Math.min(10, pick.durationSec)
    memeFixedLines = pick.fixedLines
  } else if (template_id) {
    const { data: tpl } = await supabaseAdmin
      .from('video_templates')
      .select('id, status, manifest')
      .eq('id', template_id)
      .maybeSingle()
    if (!tpl) return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    resolvedTemplateId = template_id
    const manifest = (tpl as { manifest: { duration_sec?: number; fixed_lines?: string[] } | null }).manifest
    if (manifest?.duration_sec) durationSeconds = Math.min(10, manifest.duration_sec)
    memeFixedLines = manifest?.fixed_lines ?? null
  }

  const options: string[] = model.placeholder_options ?? []
  const randomOption = options.length > 0 ? options[Math.floor(Math.random() * options.length)] : ''
  const chosen = placeholder ?? randomOption
  const personalizedText = memeFixedLines
    ? resolveMemeText(memeFixedLines, chosen)
    : post.text_template.replace(/\[placeholder\]/gi, chosen)

  let clipId: string | null = null
  let clipIndex: number | null = null

  const { data: pipelineModel } = await supabaseAdmin
    .from('pipeline_models')
    .select('id')
    .ilike('handle', username)
    .single()

  if (pipelineModel) {
    const [{ data: allFootage }, { data: existingModelClips }] = await Promise.all([
      supabaseAdmin.from('pipeline_content_bank').select('id, r2_key, label, trim_end, tags').eq('model_id', pipelineModel.id).order('created_at'),
      supabaseAdmin.from('model_clips').select('id, r2_key').eq('model_id', model.id),
    ])

    const footage = allFootage ?? []

    if (footage.length > 0) {
      // Pick a clip weighted toward the least-used so footage spreads evenly across the bank AND
      // concurrent "Generate All" requests don't all land on the same clip (the old count%length bug).
      const usage = await clipUsageMap(model.id, footage)
      const chosen_footage = pickFromUsage(footage, usage)
      clipIndex = footage.findIndex(f => f.r2_key === chosen_footage.r2_key) + 1

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

  // insertVideoJobWithSlot picks a collision-free slot (4/day cap) and retries if it loses the race.
  const res = await insertVideoJobWithSlot(model.id, {
    post_id,
    model_id: model.id,
    clip_id: clipId,
    clip_index: clipIndex,
    duration_seconds: durationSeconds,
    template_id: resolvedTemplateId,
    original_template: post.text_template,
    personalized_text: personalizedText,
    status: 'pending',
  }, { returnId: true })

  if (res.status === 'skipped_duplicate') {
    return NextResponse.json({ error: 'A job already exists for this post/model' }, { status: 409 })
  }
  if (res.status === 'error') return NextResponse.json({ error: res.error }, { status: 500 })
  return NextResponse.json({ job_id: res.id, personalized_text: personalizedText })
}
