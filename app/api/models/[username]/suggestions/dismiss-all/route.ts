import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

type Params = { params: Promise<{ username: string }> }

export async function POST(_req: NextRequest, { params }: Params) {
  const { username } = await params

  const { data: model } = await supabaseAdmin
    .from('trends_models')
    .select('id')
    .ilike('fansly_username', username)
    .single()

  if (!model) return NextResponse.json({ error: 'Model not found' }, { status: 404 })

  const { error, count } = await supabaseAdmin
    .from('trends_suggestions')
    .update({ status: 'dismissed' })
    .eq('model_id', model.id)
    .eq('status', 'pending')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ dismissed: count ?? 0 })
}
