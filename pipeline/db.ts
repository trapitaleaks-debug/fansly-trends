import { supabaseAdmin } from '../lib/supabase'

export interface PipelineModel {
  id: string
  handle: string
  fancore_model_id: string | null
  niche_tags: string[]
  signature_tag: string | null
  nsfw_flag: boolean
  source_photos_r2_prefix: string | null
  reference_image_r2_key: string | null
  kie_ref_urls: string[]
  kie_ref_uploaded_at: string | null
  best_post_times: { morning: string; evening: string }
  branding_file_text: string | null  // personal branding file from FanslyTrends model profile
  active: boolean
}

export interface PipelineRun {
  id: string
  model_id: string
  status: string
  briefs: Brief[]
  created_at: string
  approved_at: string | null
  posted_at: string | null
}

export interface PipelineVideo {
  id: string
  run_id: string
  slot: number
  status: string
  brief: Brief | null
  final_r2_key: string | null
  thumbnail_r2_key: string | null
  source_post_id: string | null
  scheduled_for: string | null
}

export type ContentFormat = 'text_overlay' | 'flashing' | 'cta' | 'viral_hook' | 'green_screen'
export type OverlayFormula = 'grammar_bait' | 'celebrity_bait' | 'trolling' | 'controversial_opinion'
export type CtaType = 'comment' | 'share' | 'follow'

export interface Brief {
  slot: number
  content_format: ContentFormat
  // Arc: hook → retention → payoff
  hook_description: string      // what happens in first 1 second
  retention_description: string // what happens 1-5s to keep watching
  payoff_description: string    // what happens in final second
  concept: string               // one-sentence summary for the video creator
  source_post_id: string
  overlay_text: string          // text burned onto video (all formats)
  overlay_formula: OverlayFormula
  cta_type?: CtaType            // for cta format
  hashtags: string[]
  caption: string               // with comment trigger or CTA
}

export async function getActiveModels(): Promise<PipelineModel[]> {
  const { data, error } = await supabaseAdmin
    .from('pipeline_models')
    .select('*')
    .eq('active', true)
  if (error) throw new Error(`getActiveModels: ${error.message}`)
  return data ?? []
}

export async function getModel(handle: string): Promise<PipelineModel | null> {
  const { data } = await supabaseAdmin
    .from('pipeline_models')
    .select('*')
    .eq('handle', handle)
    .single()
  return data ?? null
}

export async function updateModelKieRefs(modelId: string, kieRefUrls: string[]) {
  const { error } = await supabaseAdmin
    .from('pipeline_models')
    .update({ kie_ref_urls: kieRefUrls, kie_ref_uploaded_at: new Date().toISOString() })
    .eq('id', modelId)
  if (error) throw new Error(`updateModelKieRefs: ${error.message}`)
}

export async function createRun(modelId: string, briefs: Brief[]): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('pipeline_runs')
    .insert({ model_id: modelId, status: 'generating', briefs })
    .select('id')
    .single()
  if (error) throw new Error(`createRun: ${error.message}`)
  return data.id
}

export async function updateRunStatus(runId: string, status: string) {
  const { error } = await supabaseAdmin
    .from('pipeline_runs')
    .update({ status })
    .eq('id', runId)
  if (error) throw new Error(`updateRunStatus: ${error.message}`)
}

export async function getRun(runId: string): Promise<PipelineRun | null> {
  const { data } = await supabaseAdmin
    .from('pipeline_runs')
    .select('*')
    .eq('id', runId)
    .single()
  return data ?? null
}

export async function getPendingApprovalRuns(): Promise<PipelineRun[]> {
  const { data } = await supabaseAdmin
    .from('pipeline_runs')
    .select('*')
    .eq('status', 'pending_approval')
  return data ?? []
}

export async function createVideo(
  runId: string,
  slot: number,
  brief: Brief,
  sourcePostId: string
): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('pipeline_videos')
    .insert({ run_id: runId, slot, status: 'pending', brief, source_post_id: sourcePostId })
    .select('id')
    .single()
  if (error) throw new Error(`createVideo: ${error.message}`)
  return data.id
}

export async function updateVideo(videoId: string, updates: Partial<PipelineVideo>) {
  const { error } = await supabaseAdmin
    .from('pipeline_videos')
    .update(updates)
    .eq('id', videoId)
  if (error) throw new Error(`updateVideo: ${error.message}`)
}

export async function getRunVideos(runId: string): Promise<PipelineVideo[]> {
  const { data, error } = await supabaseAdmin
    .from('pipeline_videos')
    .select('*')
    .eq('run_id', runId)
    .order('slot')
  if (error) throw new Error(`getRunVideos: ${error.message}`)
  return data ?? []
}

export async function getTrendingPosts(nicheTags: string[], limit = 10) {
  // Try niche-filtered first, fall back to any viral posts
  const { data: nicheData } = await supabaseAdmin
    .from('trends_posts')
    .select('fansly_post_id, creator_username, caption, hashtags, likes_current, growth_24h_pct, video_r2_key, video_duration')
    .overlaps('hashtags', nicheTags)
    .gte('likes_current', 300)
    .is('archived_at', null)
    .order('growth_24h_pct', { ascending: false, nullsFirst: false })
    .limit(limit)

  if ((nicheData?.length ?? 0) >= 3) return nicheData ?? []

  // Fallback: any recent viral posts
  const { data: fallback } = await supabaseAdmin
    .from('trends_posts')
    .select('fansly_post_id, creator_username, caption, hashtags, likes_current, growth_24h_pct, video_r2_key, video_duration')
    .gte('likes_current', 500)
    .is('archived_at', null)
    .order('likes_current', { ascending: false })
    .limit(limit)

  return fallback ?? []
}
