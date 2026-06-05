import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { r2 } from '@/lib/r2'
import { GetObjectCommand } from '@aws-sdk/client-s3'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data } = await supabaseAdmin
    .from('trends_posts')
    .select('thumbnail_r2_key')
    .eq('id', id)
    .single()

  if (!data?.thumbnail_r2_key) return new NextResponse('Not found', { status: 404 })

  let obj
  try {
    obj = await r2.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME ?? 'fansly-trends',
      Key: data.thumbnail_r2_key,
    }))
  } catch {
    return new NextResponse('Not found', { status: 404 })
  }

  const bytes = await obj.Body?.transformToByteArray()
  if (!bytes) return new NextResponse('Not found', { status: 404 })

  return new NextResponse(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
    },
  })
}
