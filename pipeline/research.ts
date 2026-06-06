import Anthropic from '@anthropic-ai/sdk'
import type { Brief, ContentFormat, OverlayFormula, PipelineModel } from './db'
import { getTrendingPosts } from './db'
import { supabaseAdmin } from '../lib/supabase'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

interface TagsResponse {
  highestImpact: Array<{ tag: string; impactScore: number }>
  fastestRising: Array<{ tag: string; changePct: number | null }>
  lowestSaturation: Array<{ tag: string; saturationScore: number }>
}

async function fetchHashtags(): Promise<TagsResponse> {
  try {
    const res = await fetch('https://fansly-tags.vercel.app/api/tags', {
      headers: { 'Cache-Control': 'no-store' },
    } as RequestInit)
    if (!res.ok) throw new Error(`Tags API ${res.status}`)
    return await res.json() as TagsResponse
  } catch (e) {
    console.error('  ⚠ Could not fetch fansly-tags:', (e as Error).message)
    return { highestImpact: [], fastestRising: [], lowestSaturation: [] }
  }
}

// Tags that are niche-irrelevant for a general pool — evergreen tags come from model.niche_tags directly
const BLOCKED_GENERAL_TAGS = new Set([
  'anal', 'trans', 'femboy', 'creampie', 'gangbang', 'squirt', 'fart', 'scat',
  'bdsm', 'dominatrix', 'cuckold', 'feet', 'footfetish', 'furry', 'hentai',
  'anime', 'cartoon', 'shemale', 'ladyboy',
  'pumpkin', 'dashaangel', // specific creator tags that leak into trending pools
])

interface HashtagPools {
  fixed: string[]   // evergreen (3) + signature (1) — same for all slots
  impact: string[]  // 9-tag pool — rotated per slot
  rising: string[]  // 9-tag pool — rotated per slot
  lowSat: string[]  // fallback padding pool
}

/**
 * Builds larger hashtag pools so each slot gets a different 3+3 selection
 * from the Impact + Rising buckets. Per SOP: vary 3-4 tags between consecutive posts.
 */
function buildHashtagPools(tags: TagsResponse, signatureTag: string | null, nicheTags: string[]): HashtagPools {
  const nicheSet = new Set(nicheTags.map(t => t.toLowerCase()))
  const filterTag = (tag: string) =>
    !BLOCKED_GENERAL_TAGS.has(tag.toLowerCase()) && !nicheSet.has(tag.toLowerCase())

  const evergreen = nicheTags.slice(0, 3).map(t => `#${t.toLowerCase().replace(/\s+/g, '')}`)
  const sig = signatureTag
    ? [`#${signatureTag.replace(/^#/, '').toLowerCase().replace(/\s+/g, '')}`]
    : []

  return {
    fixed: [...new Set([...evergreen, ...sig])].slice(0, 4),
    impact: tags.highestImpact.filter(t => filterTag(t.tag)).slice(0, 9).map(t => `#${t.tag}`),
    rising: tags.fastestRising.filter(t => filterTag(t.tag)).slice(0, 9).map(t => `#${t.tag}`),
    lowSat: tags.lowestSaturation.filter(t => filterTag(t.tag)).slice(0, 6).map(t => `#${t.tag}`),
  }
}

/**
 * Picks a different Impact+Rising window per slot.
 * Shift by 2 each slot → 4 rotating tags differ between consecutive posts.
 * SOP rule: "vary at least 3-4 tags between consecutive posts"
 */
function buildSlotHashtags(pools: HashtagPools, slotIndex: number): string[] {
  const pickRotated = (arr: string[], start: number, count: number): string[] => {
    if (arr.length === 0) return []
    const result: string[] = []
    for (let i = 0; i < arr.length && result.length < count; i++) {
      result.push(arr[(start + i) % arr.length])
    }
    return result
  }

  const shift = slotIndex * 2
  const selectedImpact = pickRotated(pools.impact, shift, 3)
  const selectedRising = pickRotated(pools.rising, shift + 1, 3)  // +1 offset from impact for more variety

  const seen = new Set<string>()
  const tags = [...pools.fixed, ...selectedImpact, ...selectedRising].filter(t => {
    if (seen.has(t)) return false
    seen.add(t)
    return true
  })

  for (const t of pools.lowSat) {
    if (tags.length >= 10) break
    if (!seen.has(t)) { seen.add(t); tags.push(t) }
  }

  return tags.slice(0, 10)
}

/**
 * Gets the content formats used in the last successful run for this model.
 * Used to avoid repeating the same format sequence across cycles.
 */
async function getLastCycleFormats(modelId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from('pipeline_runs')
    .select('briefs')
    .eq('model_id', modelId)
    .not('status', 'eq', 'failed')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (!data?.briefs) return []
  return (data.briefs as Brief[])
    .map(b => b.content_format)
    .filter((f): f is ContentFormat => Boolean(f))
}

const SYSTEM_PROMPT = `You are a short-form video content strategist for a creator platform similar to TikTok.

Your job: write content briefs for 7–15 second reels that stop the scroll, retain viewers, and trigger comments or shares. Every reel must follow this arc:

**HOOK (0–1s)** → stop the scroll with a visual or text stimulus
**RETENTION (1–5s)** → build tension, curiosity, or anticipation
**TEASE** → a near-payoff that makes viewers wait for the end
**PAYOFF (final second)** → the reward: a reveal, a punchline, an unexpected expression, a flash

The creator: Italian, curvy, confident, flirtatious. Mediterranean aesthetic. GFE (girlfriend experience) personality. All text overlays are from her first-person perspective.

---

## CONTENT FORMATS — assign one per slot, vary all 6 slots across different formats

### 1. text_overlay
A bold text overlay is the primary engagement driver. The text must trigger: correction instinct, debate, curiosity, or in-group identity.

**Overlay formulas (pick the best fit):**

*grammar_bait* — a deliberate grammar or spelling mistake that makes viewers want to correct it:
- "What would you do to me if I be with you on the bed? 😜"
- "Would you live your wife to date me?"
- "Your loosing out and you already know 😘"
- "I could of had you but you waited to long 😏"

*celebrity_bait* — name-drop a celebrity to spark debate or possessive reactions:
- "Kanye West just subscribed to my page... what picture should I send him? 🤔"
- "Mr Beast is in my DMs... do you think I should give him a chance? 🤔"
- "Bill Gates > Brad Pitt. Why? One word: EXPERIENCE. Few will understand 🙏"
- "Monica Bellucci called. She wants tips 💅"

*trolling* — a bold scenario or statement half the audience loves, half hates:
- "You enter the bathroom and find me. I invite you to join. What do you do?"
- "I'm a virgin. I hope you won't judge me 🙏"
- "Girls with bodies like mine get everything they want ✨"
- "If you woke up and found THIS in your bed 😳"

*controversial_opinion* — a confident take most people half-agree with:
- "Man over 35 > handsome 20-year-old. No need to explain why..."
- "European girls are just built different, sorry 🌊"
- "Soft women finish last and I said what I said 👑"
- "Older men just get it and we all know it 🔥"

### 2. flashing
The video builds anticipation through a slow reveal or build-up, then ends with a very fast (0.1–0.2 second) revealing frame. The flash is too brief to catch in one watch → triggers replays → high watch time signal. Describe the build-up and what the final flash shows.

### 3. cta
A single direct call-to-action. One action only — never layer two CTAs.
- *comment*: ask a specific question that's easy to answer ("comment ❤️ if you do", "what would you do?")
- *share*: ask viewers to send to a friend with a specific framing ("anyone likes [trait]? send this to someone who'd appreciate it")
- *follow*: promise something for new followers ("if you start following from this reel, I'll send you something 😋")

Overlay text must be the CTA itself — short, direct, specific to one type of viewer.

### 4. viral_hook
Opens with a recognizable high-energy moment (a ball flying at the camera, an explosion, a sports fail, a jump scare), hard-cut to the model. The viewer's rat brain is already activated by the hook before they even see the creator. The transition should be motivated: motion matches motion, or reaction matches event.

Describe the hook clip type and the exact transition to the model's content.

### 5. green_screen
A reaction clip of the model (shocked, laughing, blushing, eye roll) is overlaid on a main video. The main video context creates the narrative — the model's reaction is the punchline. Add a caption bait line for context ("I lost a bet to my friend's dad…", "She had no idea this was being filmed").

---

## OVERLAY TEXT RULES (all formats)
- Max 55 characters
- No explicit language — platform filters catch it
- Confident first-person female perspective where applicable
- Must be native to short-form video, never ad-like
- End with an emoji for extra engagement

## CAPTION RULES
- 1–2 sentences max
- Include either a divisive question OR a soft CTA
- Tone: playful, direct, personal — like she's talking to one specific person
- Comment-bait: ask something easy to answer or take a position viewers can agree/disagree with`

export async function generateBriefs(model: PipelineModel): Promise<Brief[]> {
  console.log(`[research] Generating briefs for @${model.handle}`)

  const [trendingPosts, tags, lastFormats] = await Promise.all([
    getTrendingPosts(model.niche_tags, 10),
    fetchHashtags(),
    getLastCycleFormats(model.id),
  ])

  console.log(`  Trending posts found: ${trendingPosts.length}`)
  console.log(`  Branding file: ${model.branding_file_text ? `${model.branding_file_text.length} chars` : 'MISSING — briefs will be generic'}`)
  if (lastFormats.length > 0) console.log(`  Last cycle formats: ${lastFormats.join(', ')}`)

  const hashtagPools = buildHashtagPools(tags, model.signature_tag, model.niche_tags)
  console.log(`  Hashtag pools — impact: ${hashtagPools.impact.length} tags, rising: ${hashtagPools.rising.length} tags`)

  // Trending context — performance stats only, NO captions (captions are explicit)
  const trendContext = trendingPosts.length > 0
    ? trendingPosts.map((p, i) =>
        `${i + 1}. @${p.creator_username} | ${p.likes_current} likes | ${p.growth_24h_pct ?? 0}% growth | ${p.video_duration ?? 7}s | ID: ${p.fansly_post_id}`
      ).join('\n')
    : Array.from({ length: 6 }, (_, i) => `${i + 1}. @sample | ID: mock_post_${i + 1}`).join('\n')

  const formatDiversityNote = lastFormats.length > 0
    ? `\nLast cycle format sequence was: ${lastFormats.join(', ')}. Use a DIFFERENT sequence this cycle — don't repeat the same order.`
    : ''

  const userPrompt = `Write 6 content briefs for 7–15 second reels. Vary the content_format across all 6 slots — do not repeat the same format more than twice. Use different overlay formulas within text_overlay slots.${formatDiversityNote}

Source the audio from these trending videos (use their IDs as source_post_id):
${trendContext}

Return ONLY a JSON array, no other text:
[
  {
    "slot": 1,
    "content_format": "text_overlay|flashing|cta|viral_hook|green_screen",
    "hook_description": "What happens in the first 1 second to stop the scroll",
    "retention_description": "What happens 1-5s to keep them watching",
    "payoff_description": "What happens in the final second — the reward",
    "concept": "One sentence describing the full video for the creator",
    "source_post_id": "id_from_above",
    "overlay_text": "Text burned on video, max 55 chars, with emoji",
    "overlay_formula": "grammar_bait|celebrity_bait|trolling|controversial_opinion",
    "cta_type": "comment|share|follow or null if not cta format",
    "caption": "1-2 sentence post caption with comment trigger or soft CTA"
  }
]`

  // Inject branding file into system prompt if available
  const brandingSection = model.branding_file_text
    ? `\n\n---\n\n## THIS MODEL'S BRANDING FILE\n\nUse this to make every brief specific to her — personality, tone, visual style, content themes.\n\n${model.branding_file_text}`
    : ''

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: SYSTEM_PROMPT + brandingSection + '\n\n---\n\n' + userPrompt }],
    }],
  })

  const text = (response.content[0] as { type: string; text: string }).text.trim()

  const jsonMatch = text.match(/\[[\s\S]*\]/m)
  if (!jsonMatch) throw new Error(`Claude returned non-JSON: ${text.slice(0, 200)}`)

  const briefs: Brief[] = JSON.parse(jsonMatch[0])
  if (!Array.isArray(briefs) || briefs.length === 0) throw new Error('Claude returned empty briefs array')

  const fallbackPostId = trendingPosts[0]?.fansly_post_id ?? 'unknown'

  return briefs.map((b, i) => ({
    slot: i + 1,
    content_format: (b.content_format ?? 'text_overlay') as ContentFormat,
    hook_description: b.hook_description ?? '',
    retention_description: b.retention_description ?? '',
    payoff_description: b.payoff_description ?? '',
    concept: b.concept ?? '',
    source_post_id: b.source_post_id ?? fallbackPostId,
    overlay_text: b.overlay_text ?? '',
    overlay_formula: (b.overlay_formula ?? 'trolling') as OverlayFormula,
    cta_type: b.cta_type ?? undefined,
    // Hashtags injected programmatically with per-slot rotation — never from Claude
    hashtags: buildSlotHashtags(hashtagPools, i),
    caption: b.caption ?? '',
  }))
}
