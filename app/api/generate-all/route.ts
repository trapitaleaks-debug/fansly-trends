import { NextRequest, NextResponse } from 'next/server'

// POST /api/generate-all
// Delegates to Railway's /jobs/fill-gaps, which inserts video_jobs for all
// matched ideas without an active job — directly on Railway (no Vercel timeout).
export async function POST(_request: NextRequest) {
  const pipelineUrl = process.env.PIPELINE_SERVICE_URL ?? 'http://localhost:3001'

  try {
    const res = await fetch(`${pipelineUrl}/jobs/fill-gaps`, { method: 'POST' })
    if (!res.ok) {
      return NextResponse.json({ error: `Railway returned ${res.status}` }, { status: 502 })
    }
    const body = await res.json()
    return NextResponse.json({ message: 'fill-gaps triggered on Railway', ...body })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
