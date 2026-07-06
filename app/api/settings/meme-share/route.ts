import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

const KEY = 'meme_share'

// Percentage of generated videos that use a MEME layout (the rest are caption videos that may
// carry a style). Consumed by lib/template-select.ts at job creation.
export async function GET() {
  const { data } = await supabaseAdmin.from('trends_settings').select('value').eq('key', KEY).maybeSingle()
  return NextResponse.json({ meme_share: Number(data?.value ?? 25) })
}

export async function PUT(request: NextRequest) {
  const { meme_share } = await request.json()
  const v = Math.min(100, Math.max(0, Number(meme_share)))
  if (Number.isNaN(v)) return NextResponse.json({ error: 'meme_share must be a number 0-100' }, { status: 400 })
  const { error } = await supabaseAdmin.from('trends_settings').upsert({ key: KEY, value: v }, { onConflict: 'key' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, meme_share: v })
}
