import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getSignedVideoUrl } from '@/lib/r2'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  try {
    const { handle } = await params

    const { data: model, error: modelError } = await supabaseAdmin
      .from('pipeline_models')
      .select('*')
      .eq('handle', handle)
      .single()

    if (modelError) {
      if (modelError.code === 'PGRST116') return NextResponse.json({ error: 'Model not found' }, { status: 404 })
      return NextResponse.json({ error: modelError.message }, { status: 500 })
    }

    const { data: recentRuns, error: runsError } = await supabaseAdmin
      .from('pipeline_runs')
      .select('id, status, created_at, approved_at')
      .eq('model_id', model.id)
      .order('created_at', { ascending: false })
      .limit(5)

    if (runsError) return NextResponse.json({ error: runsError.message }, { status: 500 })

    const { data: contentBank } = await supabaseAdmin
      .from('pipeline_content_bank')
      .select('id, type, r2_key, label, created_at')
      .eq('model_id', model.id)
      .order('created_at', { ascending: false })

    let character_sheet_signed_url: string | null = null
    if (model.character_sheet_r2_key) {
      character_sheet_signed_url = await getSignedVideoUrl(model.character_sheet_r2_key, 3600).catch(() => null)
    }

    return NextResponse.json({
      model: {
        ...model,
        status: model.active ? 'active' : 'inactive',
        content_bank: contentBank ?? [],
        character_sheet_signed_url,
      },
      recentRuns: recentRuns ?? [],
    })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  try {
    const { handle } = await params
    const body = await request.json()

    const allowed = ['active', 'videos_per_cycle', 'flash_frame_enabled', 'notes_for_ai', 'branding_file_text', 'pinned_character_sheet_key']
    const update: Record<string, unknown> = {}
    for (const key of allowed) {
      if (key in body) update[key] = body[key]
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    const { error } = await supabaseAdmin
      .from('pipeline_models')
      .update(update)
      .eq('handle', handle)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
