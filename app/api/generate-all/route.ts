import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// POST /api/generate-all
// Triggers generation for every matched idea with no active video job,
// across all models, in parallel. Reuses the per-model matched-ideas API
// so niche/content-bank filtering is identical to the model page.
export async function POST(request: NextRequest) {
  const { duration = 5 } = await request.json().catch(() => ({}))
  const durationSeconds = Math.min(15, Math.max(3, Math.round(duration)))

  const host = request.headers.get('host') ?? 'localhost:3000'
  const protocol = host.includes('localhost') ? 'http' : 'https'
  const baseUrl = `${protocol}://${host}`
  // Forward auth cookie so internal fetches pass middleware
  const cookie = request.headers.get('cookie') ?? ''

  // 1. All models
  const { data: models, error: modelsErr } = await supabaseAdmin
    .from('trends_models')
    .select('id, fansly_username, niches')
    .order('model_number', { ascending: true, nullsFirst: false })
  if (modelsErr) return NextResponse.json({ error: modelsErr.message }, { status: 500 })

  const activeModels = (models ?? []).filter(m => m.niches?.length)

  // 2. Per model: fetch matched ideas (reuses existing working logic),
  //    then fire generate-idea for each not-yet-generated idea.
  const allTasks = await Promise.all(
    activeModels.map(async model => {
      const res = await fetch(`${baseUrl}/api/models/${model.fansly_username}/matched-ideas`, {
        headers: { cookie },
      })
      if (!res.ok) return []

      const { ideas } = await res.json() as {
        ideas: Array<{
          trends_posts: {
            id: string
            text_template: string | null
            video_jobs: Array<{ id: string; status: string; model_id: string; output_r2_key: string | null }>
          }
        }>
      }

      return (ideas ?? [])
        .filter(idea => {
          const jobs = idea.trends_posts?.video_jobs ?? []
          const hasActive = jobs.some(j =>
            j.model_id === model.id &&
            ['done', 'approved', 'posting', 'posted'].includes(j.status) &&
            j.output_r2_key
          )
          const hasInFlight = jobs.some(j =>
            j.model_id === model.id &&
            ['pending', 'processing'].includes(j.status)
          )
          return !hasActive && !hasInFlight && idea.trends_posts?.text_template
        })
        .map(idea => ({ username: model.fansly_username, postId: idea.trends_posts.id }))
    })
  )

  const tasks = allTasks.flat()

  // Debug: per-model idea counts
  const debug = activeModels.map((m, i) => ({
    model: m.fansly_username,
    ideas: allTasks[i]?.length ?? 0,
  }))

  if (tasks.length === 0) {
    return NextResponse.json({ triggered: 0, message: 'Nothing new to generate — all ideas already have jobs.', debug })
  }

  // 3. Fire all generate-idea calls in parallel
  const results = await Promise.allSettled(
    tasks.map(({ username, postId }) =>
      fetch(`${baseUrl}/api/models/${username}/generate-idea`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ post_id: postId, duration: durationSeconds }),
      }).then(r => ({ username, ok: r.ok }))
    )
  )

  const succeeded = results.filter(r => r.status === 'fulfilled' && r.value.ok).length
  const failed = tasks.length - succeeded

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
