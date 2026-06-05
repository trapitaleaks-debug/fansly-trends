import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('trends_blacklist')
    .select('username, added_at')
    .order('added_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ blacklist: data ?? [] })
}

export async function POST(request: NextRequest) {
  const { username } = await request.json()
  if (!username) return NextResponse.json({ error: 'username required' }, { status: 400 })
  const { error } = await supabaseAdmin
    .from('trends_blacklist')
    .upsert({ username: username.toLowerCase().trim() })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const { username } = await request.json()
  const { error } = await supabaseAdmin.from('trends_blacklist').delete().eq('username', username)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
