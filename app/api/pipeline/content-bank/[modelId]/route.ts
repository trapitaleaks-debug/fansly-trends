import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { r2 } from '@/lib/r2'
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
