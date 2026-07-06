import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

type Params = { params: Promise<{ id: string }> }

// Clone a template as a draft copy — iterate on text/tags/manifest without touching the live one.
export async function POST(_request: NextRequest, { params }: Params) {
  const { id } = await params
  const { data: src, error } = await supabaseAdmin
    .from('video_templates')
    .select('name, kind, manifest, source_r2_key, preview_r2_key, content_tags, niches, weight')
    .eq('id', id)
    .single()
  if (error || !src) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: copy, error: insErr } = await supabaseAdmin
    .from('video_templates')
    .insert({ ...src, name: `${src.name} (copy)`, status: 'draft' })
    .select('id')
    .single()
  if (insErr || !copy) return NextResponse.json({ error: insErr?.message ?? 'insert failed' }, { status: 500 })
  return NextResponse.json({ id: copy.id }, { status: 201 })
}
