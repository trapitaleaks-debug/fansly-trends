import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

const PIPELINE_SERVICE_URL = process.env.PIPELINE_SERVICE_URL ?? 'http://localhost:3001'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  try {
    const { videoId } = await params
    const body = await request.json().catch(() => ({}))
    const { feedback } = body as { feedback?: string }

    // Store feedback in brief before forwarding to Railway
    if (feedback) {
      const { data: video } = await supabaseAdmin
        .from('pipeline_videos')
        .select('brief')
        .eq('id', videoId)
        .single()

      if (video) {
        const brief = (video.brief as Record<string, unknown>) ?? {}
        const history = (brief.feedback_history as unknown[]) ?? []
        history.push({ feedback, at: new Date().toISOString() })
        await supabaseAdmin
          .from('pipeline_videos')
          .update({ brief: { ...brief, reprocess_feedback: feedback, feedback_history: history } })
          .eq('id', videoId)
      }
    }

    const res = await fetch(`${PIPELINE_SERVICE_URL}/regenerate/${videoId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => 'Unknown error')
      return NextResponse.json({ error: text }, { status: res.status })
    }

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
