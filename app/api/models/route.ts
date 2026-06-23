import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  const [{ data, error }, { data: counts }] = await Promise.all([
    supabaseAdmin
      .from('trends_models')
      .select('id, fansly_username, fansly_url, niches, model_number, created_at, updated_at')
      .order('model_number', { ascending: true, nullsFirst: false })
      .order('fansly_username'),
    supabaseAdmin.rpc('get_content_bank_counts'),
  ])

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const countMap: Record<string, number> = {}
  for (const row of counts ?? []) countMap[row.handle] = Number(row.video_count)

  const models = (data ?? []).map(m => ({
    id: m.id,
    fansly_username: m.fansly_username,
    fansly_url: m.fansly_url,
    niches: m.niches ?? [],
    model_number: m.model_number ?? null,
    content_bank_count: countMap[m.fansly_username] ?? 0,
    created_at: m.created_at,
    updated_at: m.updated_at,
  }))

  return NextResponse.json({ models })
}

export async function POST(request: NextRequest) {
  const body = await request.json()
  const { fansly_username } = body
  if (!fansly_username) return NextResponse.json({ error: 'fansly_username required' }, { status: 400 })

  const clean = fansly_username.replace('@', '').trim().toLowerCase()
  const { data, error } = await supabaseAdmin
    .from('trends_models')
    .insert({
      fansly_username: clean,
      fansly_url: `https://fansly.com/${clean}`,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ model: data }, { status: 201 })
}
