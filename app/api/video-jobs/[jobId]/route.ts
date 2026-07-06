import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getSignedVideoUrl } from '@/lib/r2'

type Params = { params: Promise<{ jobId: string }> }

export async function GET(_request: NextRequest, { params }: Params) {
  const { jobId } = await params
  const { data, error } = await supabaseAdmin
    .from('video_jobs')
    .select('id, status, output_r2_key, thumbnail_r2_key, error_message, personalized_text')
    .eq('id', jobId)
    .single()
  if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let video_url: string | null = null
  let thumb_url: string | null = null
  if (data.output_r2_key) video_url = await getSignedVideoUrl(data.output_r2_key, 3600).catch(() => null)
  if (data.thumbnail_r2_key) thumb_url = await getSignedVideoUrl(data.thumbnail_r2_key, 3600).catch(() => null)

  return NextResponse.json({ ...data, video_url, thumb_url })
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { jobId } = await params
  const body = await request.json()

  // Flagged-tab "Re-try" — full reset of a flagged/failed post so the pool re-posts it fresh.
  if (body.action === 'retry_post') {
    const { error } = await supabaseAdmin.from('video_jobs').update({
      status: 'approved', post_fail_count: 0, scheduled_for: null, started_at: null,
      error_message: null, failure_kind: null, needs_review: false, diagnosis: null,
      updated_at: new Date().toISOString(),
    }).eq('id', jobId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  const allowed = ['personalized_text', 'clip_id', 'status']
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowed) {
    if (key in body) update[key] = body[key]
  }
  const { error } = await supabaseAdmin.from('video_jobs').update(update).eq('id', jobId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { jobId } = await params
  const { error } = await supabaseAdmin.from('video_jobs').delete().eq('id', jobId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
