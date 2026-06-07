import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

const PIPELINE_SERVICE_URL = process.env.PIPELINE_SERVICE_URL ?? 'http://localhost:3001'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const handle = searchParams.get('handle')
    const limit = parseInt(searchParams.get('limit') ?? '20')

    if (!handle) return NextResponse.json({ error: 'handle required' }, { status: 400 })

    const { data: model, error: modelError } = await supabaseAdmin
      .from('pipeline_models')
      .select('id, handle')
      .eq('handle', handle)
      .single()

    if (modelError) {
      if (modelError.code === 'PGRST116') return NextResponse.json({ error: 'Model not found' }, { status: 404 })
      return NextResponse.json({ error: modelError.message }, { status: 500 })
    }

    const { data: runs, error: runsError } = await supabaseAdmin
      .from('pipeline_runs')
      .select('*')
      .eq('model_id', model.id)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (runsError) return NextResponse.json({ error: runsError.message }, { status: 500 })

    const runsWithModel = (runs ?? []).map(r => ({ ...r, model }))
    return NextResponse.json({ runs: runsWithModel })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { handle } = body
    if (!handle) return NextResponse.json({ error: 'handle required' }, { status: 400 })

    const { data: model, error: modelError } = await supabaseAdmin
      .from('pipeline_models')
      .select('id, handle')
      .eq('handle', handle)
      .single()

    if (modelError) {
      if (modelError.code === 'PGRST116') return NextResponse.json({ error: 'Model not found' }, { status: 404 })
      return NextResponse.json({ error: modelError.message }, { status: 500 })
    }

    const { data: run, error: runError } = await supabaseAdmin
      .from('pipeline_runs')
      .insert({ model_id: model.id, status: 'queued' })
      .select('id')
      .single()

    if (runError) return NextResponse.json({ error: runError.message }, { status: 500 })

    fetch(`${PIPELINE_SERVICE_URL}/trigger/${handle}`, { method: 'POST' }).catch(async () => {
      await supabaseAdmin
        .from('pipeline_runs')
        .update({ status: 'failed' })
        .eq('id', run.id)
    })

    return NextResponse.json({ runId: run.id }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
