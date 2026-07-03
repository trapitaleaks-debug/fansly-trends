import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

type Params = { params: Promise<{ username: string }> }

export async function GET(_request: NextRequest, { params }: Params) {
  const { username } = await params

  const { data, error } = await supabaseAdmin
    .from('trends_models')
    .select(`
      *,
      trends_suggestions(status, generated_at)
    `)
    .ilike('fansly_username', username)
    .single()

  if (error) return NextResponse.json({ error: 'Model not found' }, { status: 404 })

  const suggestions = (data.trends_suggestions ?? []) as { status: string; generated_at: string }[]
  const lastGenerated = suggestions.length > 0
    ? suggestions.sort((a, b) => new Date(b.generated_at).getTime() - new Date(a.generated_at).getTime())[0].generated_at
    : null

  return NextResponse.json({
    model: {
      ...data,
      trends_suggestions: undefined,
      suggestion_counts: {
        pending: suggestions.filter(s => s.status === 'pending').length,
        approved: suggestions.filter(s => s.status === 'approved').length,
        done: suggestions.filter(s => s.status === 'done').length,
        dismissed: suggestions.filter(s => s.status === 'dismissed').length,
      },
      last_generated_at: lastGenerated,
    },
  })
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { username } = await params
  const body = await request.json()

  const { data: model } = await supabaseAdmin
    .from('trends_models')
    .select('id')
    .ilike('fansly_username', username)
    .single()

  if (!model) return NextResponse.json({ error: 'Model not found' }, { status: 404 })

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if ('branding_file_md' in body) updates.branding_file_md = body.branding_file_md
  if ('hashtags' in body) updates.hashtags = (body.hashtags as string[]).slice(0, 50)
  if ('notes_for_ai' in body) updates.notes_for_ai = body.notes_for_ai
  if ('niches' in body) updates.niches = body.niches
  if ('placeholder_options' in body) updates.placeholder_options = body.placeholder_options
  if ('model_number' in body) updates.model_number = body.model_number

  const { data, error } = await supabaseAdmin
    .from('trends_models')
    .update(updates)
    .eq('id', model.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ model: data })
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { username } = await params

  const { error } = await supabaseAdmin
    .from('trends_models')
    .delete()
    .ilike('fansly_username', username)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
