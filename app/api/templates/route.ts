import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// Text templates (caption copy). Harvested from trending posts + user-authored customs
// (trends_posts.is_custom). Includes idea niches/tags and per-template usage counts.
export async function GET() {
  const [{ data, error }, { data: usage }] = await Promise.all([
    supabaseAdmin
      .from('trends_posts')
      .select('id, text_template, is_custom, likes_current, creator_username, thumbnail_r2_key, trends_ideas(id, niches, tags)')
      .not('text_template', 'is', null)
      .order('likes_current', { ascending: false }),
    supabaseAdmin.rpc('get_template_usage'),
  ])
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const usageMap: Record<string, { jobs: number; posted: number }> = {}
  for (const row of (usage ?? []) as Array<{ post_id: string; jobs: number; posted: number }>) {
    usageMap[row.post_id] = { jobs: Number(row.jobs), posted: Number(row.posted) }
  }

  const templates = (data ?? []).map(t => {
    const idea = (Array.isArray(t.trends_ideas) ? t.trends_ideas[0] : t.trends_ideas) as
      | { id: string; niches: string[]; tags: string[] }
      | undefined
    return {
      id: t.id,
      text_template: t.text_template,
      is_custom: t.is_custom,
      likes_current: t.likes_current ?? 0,
      creator_username: t.creator_username,
      has_video: !!t.thumbnail_r2_key,
      idea_id: idea?.id ?? null,
      niches: idea?.niches ?? [],
      tags: idea?.tags ?? [],
      jobs: usageMap[t.id]?.jobs ?? 0,
      posted: usageMap[t.id]?.posted ?? 0,
    }
  })
  return NextResponse.json({ templates })
}
