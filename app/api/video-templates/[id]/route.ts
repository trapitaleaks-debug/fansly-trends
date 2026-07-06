import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params
  const body = await request.json()
  const allowed = ['name', 'status', 'manifest', 'content_tags', 'niches', 'weight', 'preview_r2_key']
  const update: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in body) update[key] = body[key]
  }
  if (Object.keys(update).length === 0) return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  const { error } = await supabaseAdmin.from('video_templates').update(update).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { id } = await params
  // Detach any jobs pointing at this template (they fall back to the classic layout).
  await supabaseAdmin.from('video_jobs').update({ template_id: null }).eq('template_id', id)
  const { error } = await supabaseAdmin.from('video_templates').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
