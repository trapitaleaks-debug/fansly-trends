import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { generateSuggestions } from '@/lib/suggestions'

type Params = { params: Promise<{ username: string }> }

export async function POST(_request: NextRequest, { params }: Params) {
  const { username } = await params

  const { data: model } = await supabaseAdmin
    .from('trends_models')
    .select('id, branding_file_md, notes_for_ai')
    .eq('fansly_username', username.toLowerCase())
    .single()

  if (!model) return NextResponse.json({ error: 'Model not found' }, { status: 404 })
  if (!model.branding_file_md) {
    return NextResponse.json({ error: 'Upload a branding file before generating suggestions' }, { status: 400 })
  }

  // Delete all pending suggestions — regenerate from scratch, leave approved/dismissed untouched
  await supabaseAdmin
    .from('trends_suggestions')
    .delete()
    .eq('model_id', model.id)
    .eq('status', 'pending')

  try {
    const generated = await generateSuggestions(model.id, model.branding_file_md, model.notes_for_ai)
    return NextResponse.json({ generated })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[generate suggestions]', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
