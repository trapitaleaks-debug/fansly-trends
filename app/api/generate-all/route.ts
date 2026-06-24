import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// POST /api/generate-all
// Triggers generation for every matched idea that has no active video job,
// across all models, in parallel. Returns a per-model summary.
export async function POST(request: NextRequest) {
  const { duration = 5 } = await request.json().catch(() => ({}))
  const durationSeconds = Math.min(15, Math.max(3, Math.round(duration)))

  // Derive base URL for internal fetch calls to /api/models/[username]/generate-idea
  const host = request.headers.get('host') ?? 'localhost:3000'
  const protocol = host.includes('localhost') ? 'http' : 'https'
  const baseUrl = `${protocol}://${host}`

  // 1. All models with their niches
  const { data: models, error: modelsErr } = await supabaseAdmin
    .from('trends_models')
    .select('id, fansly_username, niches')
    .order('model_number', { ascending: true, nullsFirst: false })
  if (modelsErr) return NextResponse.json({ error: modelsErr.message }, { status: 500 })

  // 2. All ideas with their existing video jobs
  const { data: ideas, error: ideasErr } = await supabaseAdmin
    .from('trends_ideas')
    .select('id, niches, trends_posts(id, text_template, video_jobs(id, status, model_id, output_r2_key))')
    .order('created_at', { ascending: false })
  if (ideasErr) return NextResponse.json({ error: ideasErr.message }, { status: 500 })

  // 3. For each model, collect post_ids that have no active job
  const tasks: Array<{ username: string; postId: string }> = []

  for (const model of models ?? []) {
    if (!model.niches?.length) continue
    const modelNiches = new Set(model.niches as string[])

    for (const idea of ideas ?? []) {
      // Niche match
      if (!(idea.niches ?? []).some((n: string) => modelNiches.has(n))) continue

      // Supabase types trends_posts as array; treat single or array
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawPost = (idea as any).trends_posts
      const post = (Array.isArray(rawPost) ? rawPost[0] : rawPost) as { id: string; text_template: string; video_jobs?: { id: string; status: string; model_id: string; output_r2_key: string | null }[] } | null
      if (!post?.text_template) continue

      // Already has an active job for this model?
      const hasActive = (post.video_jobs ?? []).some(j =>
        j.model_id === model.id &&
        (j.status === 'done' || j.status === 'approved' || j.status === 'posting' || j.status === 'posted') &&
        j.output_r2_key
      )
      if (hasActive) continue

      // Also skip if there's already a pending/processing job (already generating)
      const hasInFlight = (post.video_jobs ?? []).some(j =>
        j.model_id === model.id &&
        (j.status === 'pending' || j.status === 'processing')
      )
      if (hasInFlight) continue

      tasks.push({ username: model.fansly_username, postId: post.id })
    }
  }

  if (tasks.length === 0) {
    return NextResponse.json({ triggered: 0, message: 'Nothing to generate — all ideas already have jobs.' })
  }

  // 4. Fire all generate-idea calls in parallel (pipeline cron throttles actual rendering)
  const results = await Promise.allSettled(
    tasks.map(({ username, postId }) =>
      fetch(`${baseUrl}/api/models/${username}/generate-idea`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post_id: postId, duration: durationSeconds }),
      }).then(r => ({ username, postId, ok: r.ok, status: r.status }))
    )
  )

  const succeeded = results.filter(r => r.status === 'fulfilled' && r.value.ok).length
  const failed = tasks.length - succeeded

  // Per-model summary
  const byModel: Record<string, { triggered: number; failed: number }> = {}
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    const { username, ok } = r.value
    if (!byModel[username]) byModel[username] = { triggered: 0, failed: 0 }
    if (ok) byModel[username].triggered++
    else byModel[username].failed++
  }

  return NextResponse.json({ triggered: succeeded, failed, byModel })
}
