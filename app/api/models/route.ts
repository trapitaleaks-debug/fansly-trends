import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('trends_models')
    .select(`
      id, fansly_username, fansly_url, hashtags, created_at, updated_at,
      trends_suggestions(status)
    `)
    .order('fansly_username')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const models = (data ?? []).map(m => {
    const suggestions = (m.trends_suggestions ?? []) as { status: string }[]
    return {
      id: m.id,
      fansly_username: m.fansly_username,
      fansly_url: m.fansly_url,
      hashtag_count: (m.hashtags ?? []).length,
      suggestion_counts: {
        pending: suggestions.filter(s => s.status === 'pending').length,
        done: suggestions.filter(s => s.status === 'done').length,
        dismissed: suggestions.filter(s => s.status === 'dismissed').length,
      },
      created_at: m.created_at,
      updated_at: m.updated_at,
    }
  })

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
