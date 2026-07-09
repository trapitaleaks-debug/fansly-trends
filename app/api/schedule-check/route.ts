import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const maxDuration = 30

// POST — fire-and-forget to Railway; returns 202 immediately.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
  const handle = (body as { handle?: string }).handle
  const pipelineUrl = process.env.PIPELINE_SERVICE_URL ?? 'http://localhost:3001'
  const url = `${pipelineUrl}/schedule-check${handle ? `?handle=${encodeURIComponent(handle)}` : ''}`
  await fetch(url, { method: 'POST' }).catch(() => {})
  return NextResponse.json({ status: 'running' })
}

// GET — read current snapshots directly from Supabase (instant, no Railway proxy needed).
export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('schedule_snapshots')
    .select(`
      model_id,
      scraped_at,
      scheduled_count,
      posts,
      error,
      trends_models!inner (
        fansly_username,
        model_number
      )
    `)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  // Sort by model_number ascending (nulls last) — consistent with the models list
  type TrendsModelJoin = { fansly_username: string; model_number: number | null }
  const sorted = (data ?? []).sort((a, b) => {
    const na = (a.trends_models as unknown as TrendsModelJoin).model_number ?? 9999
    const nb = (b.trends_models as unknown as TrendsModelJoin).model_number ?? 9999
    return na - nb
  })
  return NextResponse.json({ snapshots: sorted })
}
