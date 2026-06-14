import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { r2, getSignedVideoUrl } from '@/lib/r2'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'

const Bucket = process.env.R2_BUCKET_NAME ?? 'fansly-trends'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ modelId: string }> }
) {
  try {
    const { modelId } = await params
    const { searchParams } = new URL(request.url)
    const type = searchParams.get('type')
    const signedId = searchParams.get('signed')

    // Return a signed playback URL for a single item
    if (signedId) {
      const { data: item, error } = await supabaseAdmin
        .from('pipeline_content_bank')
        .select('r2_key')
        .eq('id', signedId)
        .eq('model_id', modelId)
        .single()
      if (error || !item) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      const url = await getSignedVideoUrl(item.r2_key, 3600)
      return NextResponse.json({ url })
    }

    let query = supabaseAdmin
      .from('pipeline_content_bank')
      .select('*')
      .eq('model_id', modelId)

    if (type) query = query.eq('type', type)

    const { data, error } = await query.order('created_at', { ascending: false })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ items: data ?? [] })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ modelId: string }> }
) {
  try {
    const { modelId } = await params
    const body = await request.json()
    const { id, label, tags } = body

    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    const update: Record<string, unknown> = {}
    if (typeof label === 'string') update.label = label.trim() || null
    if (Array.isArray(tags)) update.tags = tags

    const { error } = await supabaseAdmin
      .from('pipeline_content_bank')
      .update(update)
      .eq('id', id)
      .eq('model_id', modelId)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ modelId: string }> }
) {
  try {
    const { modelId } = await params
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    const { data: item, error: fetchError } = await supabaseAdmin
      .from('pipeline_content_bank')
      .select('id, r2_key')
      .eq('id', id)
      .eq('model_id', modelId)
      .single()

    if (fetchError) {
      if (fetchError.code === 'PGRST116') return NextResponse.json({ error: 'Item not found' }, { status: 404 })
      return NextResponse.json({ error: fetchError.message }, { status: 500 })
    }

    const { error: deleteError } = await supabaseAdmin
      .from('pipeline_content_bank')
      .delete()
      .eq('id', id)
      .eq('model_id', modelId)

    if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 })

    if (item.r2_key) {
      await r2.send(new DeleteObjectCommand({ Bucket, Key: item.r2_key })).catch(() => {})
    }

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
