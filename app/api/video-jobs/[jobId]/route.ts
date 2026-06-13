import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

type Params = { params: Promise<{ jobId: string }> }

export async function PATCH(request: NextRequest, { params }: Params) {
  const { jobId } = await params
  const body = await request.json()
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
