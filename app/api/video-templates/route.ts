import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getSignedUploadUrl, getSignedVideoUrl } from '@/lib/r2'

// Video templates (Wave B): user uploads CapCut exports here; Claude converts drafts into
// live manifests. Upload is a presigned PUT direct to R2 (Vercel 4.5MB body cap).

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('video_templates')
    .select('id, name, kind, status, manifest, source_r2_key, preview_r2_key, content_tags, niches, weight, created_at')
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const templates = await Promise.all(
    (data ?? []).map(async t => ({
      ...t,
      source_url: t.source_r2_key ? await getSignedVideoUrl(t.source_r2_key, 3600).catch(() => null) : null,
      preview_url: t.preview_r2_key ? await getSignedVideoUrl(t.preview_r2_key, 3600).catch(() => null) : null,
    }))
  )
  return NextResponse.json({ templates })
}

export async function POST(request: NextRequest) {
  const body = await request.json()
  const { name, kind, content_tags, filename } = body as {
    name?: string; kind?: string; content_tags?: string[]; filename?: string
  }
  if (!name || !kind || !['caption', 'meme', 'overlay'].includes(kind)) {
    return NextResponse.json({ error: 'name and kind (caption|meme|overlay) required' }, { status: 400 })
  }

  const { data: row, error } = await supabaseAdmin
    .from('video_templates')
    .insert({ name, kind, content_tags: content_tags ?? [], status: 'draft' })
    .select('id')
    .single()
  if (error || !row) return NextResponse.json({ error: error?.message ?? 'insert failed' }, { status: 500 })

  let uploadUrl: string | null = null
  if (filename) {
    const ext = (filename.split('.').pop() ?? 'mp4').toLowerCase()
    const key = `templates/src/${row.id}.${ext}`
    const contentType = ext === 'mov' ? 'video/quicktime' : 'video/mp4'
    uploadUrl = await getSignedUploadUrl(key, contentType)
    await supabaseAdmin.from('video_templates').update({ source_r2_key: key }).eq('id', row.id)
  }
  return NextResponse.json({ id: row.id, uploadUrl }, { status: 201 })
}
