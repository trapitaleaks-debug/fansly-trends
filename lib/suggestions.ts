import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin } from './supabase'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

interface ScoreInput {
  hook: number
  replayability: number
  retention: number
  payoff: number
  video_quality: number
  sexuality: number
  text_captions: number
  background: number
}

interface SuggestionInput {
  post_id: string
  reasoning: string
  branding_section: string
  what_to_change: string
  scores?: ScoreInput
}

export async function generateSuggestions(modelId: string, brandingFileMd: string, notesForAi?: string | null): Promise<number> {
  // Load posts not already suggested for this model, sorted by likes desc
  const { data: existingSuggestions } = await supabaseAdmin
    .from('trends_suggestions')
    .select('post_id')
    .eq('model_id', modelId)

  const excludedPostIds = (existingSuggestions ?? []).map(s => s.post_id)

  let postsQuery = supabaseAdmin
    .from('trends_posts')
    .select('id, creator_username, caption, hashtags, likes_current')
    .is('archived_at', null)
    .gte('likes_current', 150)
    .order('likes_current', { ascending: false })
    .limit(200)

  if (excludedPostIds.length > 0) {
    postsQuery = postsQuery.not('id', 'in', `(${excludedPostIds.join(',')})`)
  }

  const { data: posts, error: postsError } = await postsQuery
  if (postsError) throw new Error(`Failed to fetch posts: ${postsError.message}`)
  if (!posts || posts.length === 0) return 0

  const postsJson = posts.map(p => ({
    id: p.id,
    creator_username: p.creator_username,
    caption: (p.caption ?? '').slice(0, 200),
    hashtags: (p.hashtags ?? []).slice(0, 10),
    likes_current: p.likes_current,
  }))

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: 'You are a Fansly content strategy advisor. Given a model\'s Personal Branding File and a list of trending Fansly posts, identify which posts she should copy with her personal twist. Return a JSON array only — no markdown, no explanation, just the raw JSON array.',
    messages: [
      {
        role: 'user',
        content: `## Personal Branding File
${brandingFileMd}

## Trending Posts
${JSON.stringify(postsJson, null, 0)}
${notesForAi ? `\n## Important constraints — you MUST follow these when selecting and adapting suggestions\n${notesForAi}\n` : ''}
Return a JSON array of up to 20 suggestions, ranked most relevant first. Each item must have exactly these keys:
- "post_id": the UUID from the trending posts list
- "reasoning": 1-2 sentences on why this video fits her brand
- "branding_section": exact section header from her branding file (e.g. "§2B Brand Archetype — The Lover")
- "what_to_change": 1-2 concrete sentences on how she should adapt it with her personal twist
- "scores": object with 8 keys scored 0-10 each based on available text signals:
  - "hook": stop-scroll power — use likes as proxy (1000+ → 9, 500+ → 7-8, 200+ → 6, 150 → 5)
  - "replayability": rewatch likelihood — flash/loop mechanics in caption boost this
  - "retention": mid-video hold — higher likes = proven retention; short punchy captions suggest good pacing
  - "payoff": ending strength — infer from content type (flash content → 9, tease with reveal → 8, unclear → 5)
  - "video_quality": estimate from niche professionalism norms (professional niches → 7, unknown → 5)
  - "sexuality": FYP calibration — 8=perfect balance (teasing not explicit), 5=too tame, 10=likely suppressed; use hashtags
  - "text_captions": caption quality — strong hook text or CTA → 8-9, empty/generic → 3-4, no caption → 2
  - "background": setting quality — interesting location/props in caption → 7-8, bedroom only → 5, unknown → 5

Return only the JSON array.`,
      },
    ],
  })

  const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : ''

  let parsed: SuggestionInput[] = []
  try {
    // Strip any accidental markdown fences
    const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
    parsed = JSON.parse(clean)
    if (!Array.isArray(parsed)) parsed = []
  } catch {
    throw new Error(`Claude returned invalid JSON: ${raw.slice(0, 200)}`)
  }

  // Validate and filter
  const valid = parsed.filter(
    s => s.post_id && s.reasoning && s.branding_section && s.what_to_change
  )

  if (valid.length === 0) return 0

  const rows = valid.map(s => {
    const sc = s.scores
    const score_total = sc
      ? sc.hook + sc.replayability + sc.retention + sc.payoff +
        sc.video_quality + sc.sexuality + sc.text_captions + sc.background
      : null
    return {
      model_id: modelId,
      post_id: s.post_id,
      reasoning: s.reasoning,
      branding_section: s.branding_section,
      what_to_change: s.what_to_change,
      status: 'pending',
      score_hook: sc?.hook ?? null,
      score_replayability: sc?.replayability ?? null,
      score_retention: sc?.retention ?? null,
      score_payoff: sc?.payoff ?? null,
      score_video_quality: sc?.video_quality ?? null,
      score_sexuality: sc?.sexuality ?? null,
      score_text_captions: sc?.text_captions ?? null,
      score_background: sc?.background ?? null,
      score_total,
    }
  })

  const { error: insertError } = await supabaseAdmin
    .from('trends_suggestions')
    .upsert(rows, { onConflict: 'model_id,post_id', ignoreDuplicates: true })

  if (insertError) {
    throw new Error(`Failed to insert suggestions: ${insertError.message}`)
  }

  return rows.length
}

export async function suggestHashtags(brandingFileMd: string, existingHashtags: string[] = []): Promise<string[]> {
  // Fetch real trending hashtags from fansly-tags.vercel.app
  const tagsRes = await fetch('https://fansly-tags.vercel.app/api/tags?sort=views&limit=300')
  if (!tagsRes.ok) throw new Error('Failed to fetch trending hashtags from fansly-tags')
  const tagsJson = await tagsRes.json() as Record<string, unknown>
  const rawTags = (tagsJson?.mostViewed ?? tagsJson?.tags ?? []) as Record<string, unknown>[]

  // Deduplicate the source list and exclude tags the model already has
  const existingSet = new Set(existingHashtags)
  const allTags = [...new Set(
    rawTags.map(t => String(t.tag ?? '')).filter(Boolean)
  )].filter(t => !existingSet.has(t))

  if (allTags.length === 0) throw new Error('No new hashtags to suggest')

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: 'You are a Fansly content strategy advisor. Return a JSON array of strings only — no markdown, no explanation.',
    messages: [
      {
        role: 'user',
        content: `You have a list of real trending Fansly hashtags and a model's Personal Branding File. Pick up to 50 hashtags from the real list that best match this model's niche, content style, and target audience. Only return hashtags that exist in the provided list. Do not repeat any hashtag.

## Real Trending Fansly Hashtags (choose only from these)
${allTags.join(', ')}

## Personal Branding File
${brandingFileMd}

Return only a JSON array of the selected hashtag strings (without # symbol), ranked most relevant first. No duplicates.`,
      },
    ],
  })

  const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '[]'
  try {
    const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
    const tags = JSON.parse(clean)
    if (!Array.isArray(tags)) return []
    // Validate: only real tags, no duplicates, not already saved
    const tagSet = new Set(allTags)
    const seen = new Set<string>()
    return tags
      .filter((t: unknown) => {
        if (typeof t !== 'string') return false
        if (!tagSet.has(t) || seen.has(t)) return false
        seen.add(t)
        return true
      })
      .slice(0, 50)
  } catch {
    return []
  }
}
