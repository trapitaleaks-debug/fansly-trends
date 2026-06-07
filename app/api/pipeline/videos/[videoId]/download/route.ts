import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getSignedVideoUrl } from '@/lib/r2'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  try {
    const { videoId } = await params

    const { data: video, error } = await supabaseAdmin
      .from('pipeline_videos')
      .select('id, final_r2_key')
      .eq('id', videoId)
      .single()

    if (error) {
      if (error.code === 'PGRST116') return NextResponse.json({ error: 'Video not found' }, { status: 404 })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!video.final_r2_key) {
      return NextResponse.json({ error: 'Video has no file' }, { status: 404 })
    }

    const signedUrl = await getSignedVideoUrl(video.final_r2_key, 3600)
    return NextResponse.redirect(signedUrl, 307)
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
