import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { r2 } from '@/lib/r2'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const Bucket = process.env.R2_BUCKET_NAME ?? 'fansly-trends'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { model_id, type, filename, label } = body

    if (!model_id) return NextResponse.json({ error: 'model_id required' }, { status: 400 })
    if (!type) return NextResponse.json({ error: 'type required' }, { status: 400 })
    if (!filename) return NextResponse.json({ error: 'filename required' }, { status: 400 })

    const validTypes = ['own_footage', 'hook_clip', 'audio']
    if (!validTypes.includes(type)) {
      return NextResponse.json({ error: 'type must be own_footage, hook_clip, or audio' }, { status: 400 })
    }

    const { data: model, error: modelError } = await supabaseAdmin
      .from('pipeline_models')
      .select('id, handle')
      .eq('id', model_id)
      .single()

    if (modelError) {
      if (modelError.code === 'PGRST116') return NextResponse.json({ error: 'Model not found' }, { status: 404 })
      return NextResponse.json({ error: modelError.message }, { status: 500 })
    }

    const key = `models/${model.handle}/bank/${type}/${Date.now()}_${filename}`

    const uploadUrl = await getSignedUrl(
      r2,
      new PutObjectCommand({ Bucket, Key: key }),
      { expiresIn: 3600 }
    )

    const { data: item, error: insertError } = await supabaseAdmin
      .from('pipeline_content_bank')
      .insert({
        model_id,
        r2_key: key,
        type,
        label: label || filename,
      })
      .select('id')
      .single()

    if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 })

    return NextResponse.json({ uploadUrl, r2_key: key, itemId: item.id }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
