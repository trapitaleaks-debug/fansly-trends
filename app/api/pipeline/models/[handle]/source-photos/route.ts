import { NextRequest, NextResponse } from 'next/server'
import { r2, getSignedVideoUrl } from '@/lib/r2'
import { ListObjectsV2Command, DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const Bucket = process.env.R2_BUCKET_NAME ?? 'fansly-trends'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  try {
    const { handle } = await params
    const prefix = `models/${handle}/source/`
    const listing = await r2.send(new ListObjectsV2Command({ Bucket, Prefix: prefix }))
    const keys = (listing.Contents ?? []).map(o => o.Key!).filter(Boolean)

    const photos = await Promise.all(
      keys.map(async key => ({
        key,
        filename: key.split('/').pop()!,
        signedUrl: await getSignedVideoUrl(key, 3600),
      }))
    )

    return NextResponse.json({ photos })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  try {
    const { handle } = await params
    const body = await request.json()
    const filenames: string[] = Array.isArray(body.filenames) ? body.filenames : [body.filename].filter(Boolean)
    if (!filenames.length) return NextResponse.json({ error: 'filenames required' }, { status: 400 })

    const now = Date.now()
    const slots = await Promise.all(filenames.map(async (filename, i) => {
      const ext = filename.split('.').pop()?.toLowerCase() ?? 'jpg'
      const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
      const key = `models/${handle}/source/${now}_${i}.${ext}`
      const uploadUrl = await getSignedUrl(r2, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }), { expiresIn: 3600 })
      return { uploadUrl, key, contentType }
    }))

    return NextResponse.json({ slots }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  try {
    const { handle } = await params
    const { searchParams } = new URL(request.url)
    const key = searchParams.get('key')
    if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })
    if (!key.startsWith(`models/${handle}/source/`)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    await r2.send(new DeleteObjectCommand({ Bucket, Key: key }))
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
