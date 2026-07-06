import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// User-authored text templates: a trends_posts row (is_custom, holds the caption text) plus a
// trends_ideas row (niches/tags) so customs flow through the exact same matching as harvested
// templates. Custom rows are excluded from the trends Feed.
export async function POST(request: NextRequest) {
  const { text_template, niches, tags } = await request.json() as {
    text_template?: string; niches?: string[]; tags?: string[]
  }
  if (!text_template?.trim()) return NextResponse.json({ error: 'text_template required' }, { status: 400 })
  if (!niches?.length) return NextResponse.json({ error: 'at least one niche required (matching is niche-based)' }, { status: 400 })

  const { data: post, error } = await supabaseAdmin
    .from('trends_posts')
    .insert({
      fansly_post_id: `custom-${crypto.randomUUID()}`,
      creator_username: 'custom',
      text_template: text_template.trim(),
      is_custom: true,
    })
    .select('id')
    .single()
  if (error || !post) return NextResponse.json({ error: error?.message ?? 'insert failed' }, { status: 500 })

  const { error: ideaErr } = await supabaseAdmin
    .from('trends_ideas')
    .insert({ post_id: post.id, niches, tags: tags ?? [] })
  if (ideaErr) {
    await supabaseAdmin.from('trends_posts').delete().eq('id', post.id)
    return NextResponse.json({ error: ideaErr.message }, { status: 500 })
  }
  return NextResponse.json({ id: post.id }, { status: 201 })
}
