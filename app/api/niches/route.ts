import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

const COLOR_POOL = ['amber', 'teal', 'orange', 'sky', 'lime', 'violet', 'red', 'indigo', 'cyan', 'yellow']

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('trends_niches')
    .select('*')
    .order('sort_order', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ niches: data })
}

export async function POST(request: NextRequest) {
  const { name, emoji } = await request.json()
  if (!name?.trim() || !emoji?.trim()) {
    return NextResponse.json({ error: 'name and emoji required' }, { status: 400 })
  }
  const clean = name.toLowerCase().trim().replace(/\s+/g, '_')

  const { count } = await supabaseAdmin
    .from('trends_niches')
    .select('*', { count: 'exact', head: true })

  const colorKey = COLOR_POOL[(count ?? 0) % COLOR_POOL.length]

  const { data, error } = await supabaseAdmin
    .from('trends_niches')
    .insert({ name: clean, emoji: emoji.trim(), color_key: colorKey, sort_order: count ?? 99 })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'Niche already exists' }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ niche: data })
}

export async function DELETE(request: NextRequest) {
  const { name } = await request.json()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
  const { error } = await supabaseAdmin.from('trends_niches').delete().eq('name', name)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
