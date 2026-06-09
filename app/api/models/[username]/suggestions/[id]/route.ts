import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

type Params = { params: Promise<{ username: string; id: string }> }

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params
  const body = await request.json()

  const updates: Record<string, unknown> = {}
  if ('status' in body && ['pending', 'done', 'approved', 'dismissed'].includes(body.status)) {
    updates.status = body.status
  }
  if ('notes' in body) updates.notes = body.notes
  if ('dismiss_reason' in body) updates.dismiss_reason = body.dismiss_reason
  if ('footage_type' in body && ['ai', 'own'].includes(body.footage_type)) {
    updates.footage_type = body.footage_type
  }
  if ('own_footage_r2_key' in body) updates.own_footage_r2_key = body.own_footage_r2_key
  if ('own_footage_label' in body) updates.own_footage_label = body.own_footage_label
  if ('text_mode' in body && ['original', 'none', 'custom'].includes(body.text_mode)) {
    updates.text_mode = body.text_mode
  }
  if ('custom_text' in body) updates.custom_text = body.custom_text

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
