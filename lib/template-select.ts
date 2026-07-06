// Template selection at job creation (Wave B, v2 taxonomy — user decision 06.07):
//
//   Stage 1: roll meme-vs-caption using the 'meme_share' setting (% of videos that use a
//            MEME layout). Meme pool = live kind meme/overlay templates matching the idea's
//            tags AND the model's niches. Memes carry their own fixed text and NEVER a style.
//   Stage 2: caption videos pick a STYLE (live kind='caption' templates, same matching) in a
//            weighted draw against one implicit classic entry — styles dress the trending
//            caption, they don't replace it.

import { supabaseAdmin } from './supabase'

export type TemplatePick = {
  templateId: string | null // null = classic caption path
  durationSec: number | null // template-driven duration (null = caller default)
  fixedLines: string[] | null // meme text lines (null = use trending post's text_template)
}

const CLASSIC = { templateId: null, durationSec: null, fixedLines: null } as const

type TemplateRow = {
  id: string
  kind: string
  manifest: { duration_sec?: number; fixed_lines?: string[] } | null
  content_tags: string[]
  niches: string[]
  weight: number
}

let cache: { rows: TemplateRow[]; memeShare: number; loadedAt: number } | null = null

async function loadPools(): Promise<{ rows: TemplateRow[]; memeShare: number }> {
  if (cache && Date.now() - cache.loadedAt < 60_000) return cache
  const [{ data }, { data: setting }] = await Promise.all([
    supabaseAdmin.from('video_templates').select('id, kind, manifest, content_tags, niches, weight').eq('status', 'live'),
    supabaseAdmin.from('trends_settings').select('value').eq('key', 'meme_share').maybeSingle(),
  ])
  const memeShare = Math.min(100, Math.max(0, Number((setting as { value: unknown } | null)?.value ?? 25)))
  cache = { rows: (data ?? []) as TemplateRow[], memeShare, loadedAt: Date.now() }
  return cache
}

function eligible(t: TemplateRow, ideaTags: string[], modelNiches: string[]): boolean {
  const tagOk = t.content_tags.length === 0 || t.content_tags.some(tag => ideaTags.includes(tag))
  const nicheOk = t.niches.length === 0 || t.niches.some(n => modelNiches.includes(n))
  return tagOk && nicheOk
}

function weightedDraw(rows: TemplateRow[], classicWeight: number): TemplateRow | null {
  const total = classicWeight + rows.reduce((s, t) => s + Math.max(1, t.weight), 0)
  let r = Math.random() * total
  r -= classicWeight
  if (r <= 0) return null
  for (const t of rows) {
    r -= Math.max(1, t.weight)
    if (r <= 0) return t
  }
  return null
}

function toPick(t: TemplateRow): TemplatePick {
  return {
    templateId: t.id,
    durationSec: t.manifest?.duration_sec ?? null,
    fixedLines: t.manifest?.fixed_lines ?? null,
  }
}

export async function pickTemplate(
  ideaTags: string[] | null | undefined,
  modelNiches: string[] | null | undefined = [],
): Promise<TemplatePick> {
  const { rows, memeShare } = await loadPools()
  const tags = ideaTags ?? []
  const niches = modelNiches ?? []

  // Stage 1 — meme roll
  const memes = rows.filter(t => (t.kind === 'meme' || t.kind === 'overlay') && eligible(t, tags, niches))
  if (memes.length > 0 && Math.random() * 100 < memeShare) {
    const meme = weightedDraw(memes, 0)
    if (meme) return toPick(meme)
  }

  // Stage 2 — style draw (kind 'caption' = styles that dress the trending text)
  const styles = rows.filter(t => t.kind === 'caption' && eligible(t, tags, niches))
  if (styles.length === 0) return { ...CLASSIC }
  const classicWeight = parseInt(process.env.CLASSIC_TEMPLATE_WEIGHT ?? '2', 10) || 2
  const style = weightedDraw(styles, classicWeight)
  return style ? toPick(style) : { ...CLASSIC }
}

// Meme text: fixed manifest lines with the model's placeholder swapped in (same semantics
// as the classic text_template swap — no AI writing, user decision).
export function resolveMemeText(fixedLines: string[], placeholder: string): string {
  return fixedLines.join('\n').replace(/\[placeholder\]/gi, placeholder)
}
