import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getSignedVideoUrl } from '@/lib/r2'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data, error } = await supabaseAdmin
    .from('trends_posts')
    .select('*, trends_ideas(*)')
    .eq('id', id)
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 404 })

  let videoUrl: string | null = null
  if (data.video_r2_key) {
    videoUrl = await getSignedVideoUrl(data.video_r2_key, 3600)
  }

  return NextResponse.json({ post: { ...data, videoUrl } })
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await request.json()
  const allowed = ['text_template', 'niche_tags']
  const update: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in body) update[key] = body[key]
  }
  if (Object.keys(update).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  const { error } = await supabaseAdmin.from('trends_posts').update(update).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
