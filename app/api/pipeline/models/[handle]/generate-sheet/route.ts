import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  try {
    const { handle } = await params

    const { data: model, error: findError } = await supabaseAdmin
      .from('pipeline_models')
      .select('id, sheet_status')
      .eq('handle', handle)
      .single()

    if (findError || !model) {
      return NextResponse.json({ error: 'Model not found' }, { status: 404 })
    }

    if (model.sheet_status === 'starting' || model.sheet_status === 'polling') {
      return NextResponse.json({ ok: true, status: 'already_generating' })
    }

    const { error } = await supabaseAdmin
      .from('pipeline_models')
      .update({
        sheet_status: 'queued',
        sheet_kie_task_id: null,
        character_sheet_r2_key: null,
        character_sheet_generated_at: null,
        pinned_character_sheet_key: null,
      })
      .eq('id', model.id)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, status: 'queued' }, { status: 202 })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
