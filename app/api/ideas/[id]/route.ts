import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await request.json()
  const { niches, notes, tags } = body
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if ('niches' in body) updates.niches = niches
  if ('notes' in body) updates.notes = notes
  if ('tags' in body) updates.tags = tags
  const { error } = await supabaseAdmin
    .from('trends_ideas')
    .update(updates)
    .eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { error } = await supabaseAdmin.from('trends_ideas').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
