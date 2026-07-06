// Template selection at job creation (Wave B). Live templates whose content_tags are empty
// (= any video) or overlap the idea's tags compete in a weighted random draw against one
// implicit "classic caption" entry, so the pre-template look stays in rotation.

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
  weight: number
}

let cache: { rows: TemplateRow[]; loadedAt: number } | null = null

async function liveTemplates(): Promise<TemplateRow[]> {
  if (cache && Date.now() - cache.loadedAt < 60_000) return cache.rows
  const { data } = await supabaseAdmin
    .from('video_templates')
    .select('id, kind, manifest, content_tags, weight')
    .eq('status', 'live')
  cache = { rows: (data ?? []) as TemplateRow[], loadedAt: Date.now() }
  return cache.rows
}

export async function pickTemplate(ideaTags: string[] | null | undefined): Promise<TemplatePick> {
  const rows = await liveTemplates()
  const tags = ideaTags ?? []
  const eligible = rows.filter(t => t.content_tags.length === 0 || t.content_tags.some(tag => tags.includes(tag)))
  if (eligible.length === 0) return { ...CLASSIC }

  const classicWeight = parseInt(process.env.CLASSIC_TEMPLATE_WEIGHT ?? '2', 10) || 2
  const total = classicWeight + eligible.reduce((s, t) => s + Math.max(1, t.weight), 0)
  let r = Math.random() * total
  r -= classicWeight
  if (r <= 0) return { ...CLASSIC }
  for (const t of eligible) {
    r -= Math.max(1, t.weight)
    if (r <= 0) {
      return {
        templateId: t.id,
        durationSec: t.manifest?.duration_sec ?? null,
        fixedLines: t.manifest?.fixed_lines ?? null,
      }
    }
  }
  return { ...CLASSIC }
}

// Meme text: fixed manifest lines with the model's placeholder swapped in (same semantics
// as the classic text_template swap — no AI writing, user decision).
export function resolveMemeText(fixedLines: string[], placeholder: string): string {
  return fixedLines.join('\n').replace(/\[placeholder\]/gi, placeholder)
}
