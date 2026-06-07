import { NextRequest, NextResponse } from 'next/server'

const PIPELINE_SERVICE_URL = process.env.PIPELINE_SERVICE_URL ?? 'http://localhost:3001'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  try {
    const { videoId } = await params
    const body = await request.json().catch(() => ({}))

    const res = await fetch(`${PIPELINE_SERVICE_URL}/reprocess/${videoId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => 'Unknown error')
      return NextResponse.json({ error: text }, { status: res.status })
    }

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
