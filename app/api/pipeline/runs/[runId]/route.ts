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
      .select('*')
      .eq('id', runId)
      .single()

    if (runError) {
      if (runError.code === 'PGRST116') return NextResponse.json({ error: 'Run not found' }, { status: 404 })
      return NextResponse.json({ error: runError.message }, { status: 500 })
    }

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

    const videosWithVariants = (videos ?? []).map(v => ({
      ...v,
      variants: variantsByVideo[v.id] ?? [],
    }))

    return NextResponse.json({ run, videos: videosWithVariants })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
