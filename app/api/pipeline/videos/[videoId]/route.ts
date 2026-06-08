import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  try {
    const { videoId } = await params
    const body = await request.json()
    const { overlay_text, caption, selected_variant_id } = body

    const { data: video, error: videoError } = await supabaseAdmin
      .from('pipeline_videos')
      .select('*')
      .eq('id', videoId)
      .single()

    if (videoError) {
      if (videoError.code === 'PGRST116') return NextResponse.json({ error: 'Video not found' }, { status: 404 })
      return NextResponse.json({ error: videoError.message }, { status: 500 })
    }

    const { user_action, dismiss_reason, reprocess_feedback } = body

    if (overlay_text !== undefined || caption !== undefined || user_action !== undefined || dismiss_reason !== undefined || reprocess_feedback !== undefined) {
      const briefUpdate: Record<string, unknown> = { ...(video.brief ?? {}) }
      if (overlay_text !== undefined) briefUpdate.overlay_text = overlay_text
      if (caption !== undefined) briefUpdate.caption = caption
      if (user_action !== undefined) briefUpdate.user_action = user_action
      if (dismiss_reason !== undefined) briefUpdate.dismiss_reason = dismiss_reason
      if (reprocess_feedback !== undefined) {
        // Append to feedback history
        const history = (briefUpdate.feedback_history as unknown[]) ?? []
        briefUpdate.feedback_history = [...history, { feedback: reprocess_feedback, at: new Date().toISOString() }]
        briefUpdate.reprocess_feedback = reprocess_feedback
      }

      const { error } = await supabaseAdmin
        .from('pipeline_videos')
        .update({ brief: briefUpdate })
        .eq('id', videoId)

      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (selected_variant_id !== undefined) {
      const { data: variant, error: variantError } = await supabaseAdmin
        .from('pipeline_variants')
        .select('*')
        .eq('id', selected_variant_id)
        .single()

      if (variantError) {
        if (variantError.code === 'PGRST116') return NextResponse.json({ error: 'Variant not found' }, { status: 404 })
        return NextResponse.json({ error: variantError.message }, { status: 500 })
      }

      const { error: deselectError } = await supabaseAdmin
        .from('pipeline_variants')
        .update({ is_selected: false })
        .eq('video_id', videoId)
        .eq('type', variant.type)

      if (deselectError) return NextResponse.json({ error: deselectError.message }, { status: 500 })

      const variantUpdate: Record<string, unknown> = { is_selected: true }
      const { error: selectError } = await supabaseAdmin
        .from('pipeline_variants')
        .update(variantUpdate)
        .eq('id', selected_variant_id)

      if (selectError) return NextResponse.json({ error: selectError.message }, { status: 500 })

      if (variant.type === 'video') {
        const { error: videoUpdateError } = await supabaseAdmin
          .from('pipeline_videos')
          .update({ final_r2_key: variant.r2_key })
          .eq('id', videoId)

        if (videoUpdateError) return NextResponse.json({ error: videoUpdateError.message }, { status: 500 })
      }
    }

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
