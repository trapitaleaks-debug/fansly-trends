import { NextRequest, NextResponse } from 'next/server'
import { getSignedVideoUrl } from '@/lib/r2'

// Generic R2 signed-URL proxy — takes ?key=<r2_key> and redirects to a signed URL.
// Used to serve source post thumbnails/videos in the pipeline run review page.
export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key')
  if (!key) return NextResponse.json({ error: 'Missing key' }, { status: 400 })

  try {
    const signedUrl = await getSignedVideoUrl(key, 3600)
    return NextResponse.redirect(signedUrl, 307)
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
}
