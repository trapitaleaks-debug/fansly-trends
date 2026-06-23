import { NextRequest, NextResponse } from 'next/server'

const PIPELINE_SERVICE_URL = process.env.PIPELINE_SERVICE_URL ?? 'http://localhost:3001'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const res = await fetch(`${PIPELINE_SERVICE_URL}/jobs/post/${id}`, { method: 'POST' })
  if (!res.ok) return NextResponse.json({ error: 'Pipeline error' }, { status: 502 })
  return NextResponse.json({ ok: true })
}
