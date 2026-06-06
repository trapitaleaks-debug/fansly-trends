import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

type Params = { params: Promise<{ username: string; id: string }> }

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params
  const body = await request.json()

  const updates: Record<string, unknown> = {}
  if ('status' in body && ['pending', 'done', 'dismissed'].includes(body.status)) {
    updates.status = body.status
  }
  if ('notes' in body) updates.notes = body.notes

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('trends_suggestions')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ suggestion: data })
}
