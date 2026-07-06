import { NextRequest, NextResponse } from 'next/server'

type Params = { params: Promise<{ id: string }> }

// Proxy to the Railway pipeline's preview renderer (browser can't hit it cross-origin).
export async function POST(_request: NextRequest, { params }: Params) {
  const { id } = await params
  const base = process.env.PIPELINE_SERVICE_URL
  if (!base) return NextResponse.json({ error: 'PIPELINE_SERVICE_URL not configured' }, { status: 500 })
  const res = await fetch(`${base.replace(/\/$/, '')}/templates/preview/${id}`, { method: 'POST' })
  const body = await res.json().catch(() => ({}))
  return NextResponse.json(body, { status: res.status })
}
