import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

type Params = { params: Promise<{ username: string }> }

export async function GET(_request: NextRequest, { params }: Params) {
  const { username } = await params

  const { data: pipelineModel } = await supabaseAdmin
    .from('pipeline_models')
    .select('id')
    .eq('handle', username.toLowerCase())
    .single()

  if (!pipelineModel) return NextResponse.json({ footage: [] })

  const { data, error } = await supabaseAdmin
    .from('pipeline_content_bank')
    .select('id, r2_key, label, created_at')
    .eq('model_id', pipelineModel.id)
    .eq('type', 'own_footage')
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ footage: data ?? [] })
}
