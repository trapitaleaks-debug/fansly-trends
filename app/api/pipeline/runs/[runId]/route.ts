import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await params

    const { data: run, error: runError } = await supabaseAdmin
      .from('pipeline_runs')
      .select('*, pipeline_models!inner(handle)')
      .eq('id', runId)
      .single()

    if (runError) {
      if (runError.code === 'PGRST116') return NextResponse.json({ error: 'Run not found' }, { status: 404 })
      return NextResponse.json({ error: runError.message }, { status: 500 })
    }

    const { pipeline_models, ...runData } = run as typeof run & { pipeline_models: { handle: string } }
    const runWithHandle = { ...runData, handle: pipeline_models?.handle ?? '' }

    const { data: videos, error: videosError } = await supabaseAdmin
      .from('pipeline_videos')
      .select('*')
      .eq('run_id', runId)
      .order('slot')

    if (videosError) return NextResponse.json({ error: videosError.message }, { status: 500 })

    const videoIds = (videos ?? []).map(v => v.id)
    let variantsByVideo: Record<string, unknown[]> = {}

    if (videoIds.length > 0) {
      const { data: variants, error: variantsError } = await supabaseAdmin
        .from('pipeline_variants')
        .select('*')
        .in('video_id', videoIds)

      if (variantsError) return NextResponse.json({ error: variantsError.message }, { status: 500 })

      for (const v of variants ?? []) {
        const vid = v.video_id as string
        if (!variantsByVideo[vid]) variantsByVideo[vid] = []
        variantsByVideo[vid].push(v)
      }
    }

    // Fetch source post thumbnails for all videos (source_post_id = fansly_post_id in trends_posts)
    const sourcePostIds = [...new Set((videos ?? []).map(v => v.source_post_id).filter(Boolean))]
    let sourcePostsByFanslyId: Record<string, { post_db_id: string; thumbnail_r2_key: string | null; video_r2_key: string | null; creator_username: string; likes_current: number }> = {}
    if (sourcePostIds.length > 0) {
      const { data: sourcePosts } = await supabaseAdmin
        .from('trends_posts')
        .select('id, fansly_post_id, creator_username, likes_current, thumbnail_r2_key, video_r2_key')
        .in('fansly_post_id', sourcePostIds)
      for (const p of sourcePosts ?? []) {
        sourcePostsByFanslyId[p.fansly_post_id] = {
          post_db_id: p.id,
          thumbnail_r2_key: p.thumbnail_r2_key,
          video_r2_key: p.video_r2_key,
          creator_username: p.creator_username,
          likes_current: p.likes_current,
        }
      }
    }

    const videosWithVariants = (videos ?? []).map(v => {
      const brief = v.brief as Record<string, unknown> | null
      const sourcePost = v.source_post_id ? sourcePostsByFanslyId[v.source_post_id] : null
      return {
        ...v,
        // Flatten brief JSONB fields to top-level — pipeline_videos has no direct overlay_text column
        slot_number: v.slot,
        overlay_text: (brief?.overlay_text as string) ?? null,
        content_format: (brief?.content_format as string) ?? null,
        error_note: (brief?.error_note as string) ?? null,
        concept: (brief?.concept as string) ?? null,
        what_to_change: (brief?.what_to_change as string) ?? null,
        user_action: (brief?.user_action as string) ?? null,
        dismiss_reason: (brief?.dismiss_reason as string) ?? null,
        // Source post info for UI display
        source_post: sourcePost ?? null,
        variants: variantsByVideo[v.id] ?? [],
      }
    })

    return NextResponse.json({ run: runWithHandle, videos: videosWithVariants })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
