import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getSignedVideoUrl } from '@/lib/r2'

type Params = { params: Promise<{ postId: string }> }

// Template detail: full text + the original trending video (signed URLs) + idea meta.
export async function GET(_request: NextRequest, { params }: Params) {
  const { postId } = await params
  const { data, error } = await supabaseAdmin
    .from('trends_posts')
    .select('id, text_template, is_custom, likes_current, creator_username, creator_fansly_url, video_r2_key, thumbnail_r2_key, hashtags, trends_ideas(id, niches, tags)')
    .eq('id', postId)
    .single()
  if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const idea = (Array.isArray(data.trends_ideas) ? data.trends_ideas[0] : data.trends_ideas) as
    | { id: string; niches: string[]; tags: string[] } | undefined
  return NextResponse.json({
    id: data.id,
    text_template: data.text_template,
    is_custom: data.is_custom,
    likes_current: data.likes_current ?? 0,
    creator_username: data.creator_username,
    creator_fansly_url: data.creator_fansly_url,
    hashtags: data.hashtags ?? [],
    idea_id: idea?.id ?? null,
    niches: idea?.niches ?? [],
    tags: idea?.tags ?? [],
    video_url: data.video_r2_key ? await getSignedVideoUrl(data.video_r2_key, 3600).catch(() => null) : null,
    thumb_url: data.thumbnail_r2_key ? await getSignedVideoUrl(data.thumbnail_r2_key, 3600).catch(() => null) : null,
  })
}

// Edit the template's text / idea niches / idea tags (bulk actions also route here per-row).
export async function PATCH(request: NextRequest, { params }: Params) {
  const { postId } = await params
  const body = await request.json() as { text_template?: string; niches?: string[]; tags?: string[] }

  if (typeof body.text_template === 'string') {
    const { error } = await supabaseAdmin.from('trends_posts')
      .update({ text_template: body.text_template.trim() || null }).eq('id', postId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (body.niches || body.tags) {
    const update: Record<string, unknown> = {}
    if (body.niches) update.niches = body.niches
    if (body.tags) update.tags = body.tags
    const { data: idea } = await supabaseAdmin.from('trends_ideas').select('id').eq('post_id', postId).maybeSingle()
    if (idea) {
      const { error } = await supabaseAdmin.from('trends_ideas').update(update).eq('id', idea.id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    } else {
      const { error } = await supabaseAdmin.from('trends_ideas')
        .insert({ post_id: postId, niches: body.niches ?? [], tags: body.tags ?? [] })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
  }
  return NextResponse.json({ ok: true })
}

// Remove a text template: customs are deleted outright (post + idea); harvested posts keep the
// post but lose the template text (falls out of the templates list, stays in the feed).
export async function DELETE(_request: NextRequest, { params }: Params) {
  const { postId } = await params
  const { data: post } = await supabaseAdmin.from('trends_posts').select('is_custom').eq('id', postId).single()
  if (!post) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (post.is_custom) {
    await supabaseAdmin.from('trends_ideas').delete().eq('post_id', postId)
    await supabaseAdmin.from('video_jobs').update({ post_id: null }).eq('post_id', postId)
    const { error } = await supabaseAdmin.from('trends_posts').delete().eq('id', postId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    const { error } = await supabaseAdmin.from('trends_posts').update({ text_template: null }).eq('id', postId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
