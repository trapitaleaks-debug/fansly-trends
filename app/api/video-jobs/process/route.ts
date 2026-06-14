import { NextRequest, NextResponse } from 'next/server'

const PIPELINE_SERVICE_URL = process.env.PIPELINE_SERVICE_URL ?? 'http://localhost:3001'

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
  const jobId = body.jobId as string | undefined

  const url = jobId
    ? `${PIPELINE_SERVICE_URL}/jobs/process/${jobId}`
    : `${PIPELINE_SERVICE_URL}/jobs/process`

  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    const data = await res.json()
    return NextResponse.json(data)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 })
  }
}
