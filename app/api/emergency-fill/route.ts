import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const maxDuration = 30

// POST — fire the emergency fill on Railway (live sweep → recycle to 8). Returns immediately;
// the UI polls GET for phase + result.
export async function POST() {
  const pipelineUrl = process.env.PIPELINE_SERVICE_URL ?? 'http://localhost:3001'
  await fetch(`${pipelineUrl}/emergency-fill`, { method: 'POST' }).catch(() => {})
  return NextResponse.json({ status: 'running' })
}

// GET — read the current run status/result straight from Supabase.
export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('emergency_fill_runs')
    .select('running, phase, started_at, finished_at, totals, per_model, error')
    .eq('id', 'singleton')
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ run: data ?? null })
}
