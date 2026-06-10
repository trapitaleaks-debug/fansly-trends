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
  best_post_times: { morning: string; evening: string } | null
  branding_file_text: string | null
  character_sheet_r2_key: string | null
  character_sheet_generated_at: string | null
  active: boolean
  videos_per_cycle: number
  flash_frame_enabled: boolean
  pinned_character_sheet_key: string | null
  notes_for_ai: string | null
  sheet_status: string | null
  sheet_kie_task_id: string | null
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

export interface PipelineContentBank {
  id: string
  model_id: string
  r2_key: string
  type: 'own_footage' | 'hook_clip' | 'audio'
  label: string | null
  notes: string | null
  trim_start: number
  trim_end: number | null
  created_at: string
}

export interface PipelineVariant {
  id: string
  video_id: string
  type: 'image' | 'video'
  variant_idx: number
  r2_key: string
  score: number | null
  is_selected: boolean
  created_at: string
}

export type ContentFormat = 'text_overlay' | 'flashing' | 'cta' | 'viral_hook' | 'green_screen'
export type OverlayFormula = 'grammar_bait' | 'celebrity_bait' | 'trolling' | 'controversial_opinion' | 'identity_statement' | 'vulnerability_bait' | 'pov_frame'
export type CtaType = 'comment' | 'share' | 'follow'

export interface VideoScores {
  hook_power: number
  replayability: number
  retention: number
  payoff: number
  video_quality: number
  content_calibration: number
  text_captions: number
  background_props: number
  ai_quality: number    // < 5 = auto-disqualify (clearly AI)
  total: number         // sum of all 9 dimensions (max 90)
  disqualified: boolean
  notes: string
}

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
  hashtags?: string[]            // populated at posting time, not during brief generation
  quality_scores?: VideoScores | null  // set after video processing
  // Component alteration fields — vary per slot for visual diversity
  location?: string             // e.g. "candle-lit bathtub" or "LED-lit bedroom"
  props?: string                // e.g. "lollipop" or "silk sheets, velvet choker"
  color_hint?: string           // e.g. "warm pink ambient lighting"
  rewatch_trigger?: string      // how this slot engineers a replay
  // Own footage: if set, skip kie.ai entirely and use this R2 key as the raw video
  own_footage_r2_key?: string
  // Preserved from approved suggestion — shown in run review UI
  what_to_change?: string
  // User feedback fields (stored in brief JSONB, never sent to AI generation)
  user_action?: string
  dismiss_reason?: string
  reprocess_feedback?: string
  feedback_history?: Array<{ feedback: string; at: string }>
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

export async function updateModelCharacterSheet(modelId: string, r2Key: string) {
  const { error } = await supabaseAdmin
    .from('pipeline_models')
    .update({ character_sheet_r2_key: r2Key, character_sheet_generated_at: new Date().toISOString(), sheet_status: null })
    .eq('id', modelId)
  if (error) throw new Error(`updateModelCharacterSheet: ${error.message}`)
}

export async function updateModelSheetStatus(modelId: string, status: string | null) {
  const { error } = await supabaseAdmin
    .from('pipeline_models')
    .update({ sheet_status: status })
    .eq('id', modelId)
  if (error) throw new Error(`updateModelSheetStatus: ${error.message}`)
}

export async function updateModelSheetPolling(modelId: string, kieTaskId: string) {
  const { error } = await supabaseAdmin
    .from('pipeline_models')
    .update({ sheet_status: 'polling', sheet_kie_task_id: kieTaskId })
    .eq('id', modelId)
  if (error) throw new Error(`updateModelSheetPolling: ${error.message}`)
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

export async function getTopHashtagsForModel(modelId: string): Promise<string[]> {
  const { data: runs } = await supabaseAdmin
    .from('pipeline_runs')
    .select('id')
    .eq('model_id', modelId)
    .order('created_at', { ascending: false })
    .limit(10)

  if (!runs || runs.length === 0) return []

  const runIds = runs.map(r => r.id)
  const { data: analytics } = await supabaseAdmin
    .from('pipeline_analytics')
    .select('hashtags_used, top_hashtag, views')
    .in('run_id', runIds)
    .order('views', { ascending: false })
    .limit(20)

  if (!analytics || analytics.length === 0) return []

  const tagWeights = new Map<string, number>()
  for (const a of analytics) {
    const w = a.views ?? 1
    if (a.top_hashtag) tagWeights.set(a.top_hashtag, (tagWeights.get(a.top_hashtag) ?? 0) + w * 2)
    for (const tag of (a.hashtags_used ?? [])) {
      tagWeights.set(tag, (tagWeights.get(tag) ?? 0) + w)
    }
  }

  return Array.from(tagWeights.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tag]) => tag)
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

// Get all content bank items for a model, optionally filtered by type
export async function getContentBank(modelId: string, type?: string): Promise<PipelineContentBank[]> {
  let query = supabaseAdmin
    .from('pipeline_content_bank')
    .select('*')
    .eq('model_id', modelId)
    .order('created_at', { ascending: false })

  if (type) {
    query = query.eq('type', type)
  }

  const { data, error } = await query
  if (error) throw new Error(`getContentBank: ${error.message}`)
  return data ?? []
}

// Delete a content bank item by id
export async function deleteContentBankItem(itemId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('pipeline_content_bank')
    .delete()
    .eq('id', itemId)
  if (error) throw new Error(`deleteContentBankItem: ${error.message}`)
}

// Save all variants (images or videos) for a slot
export async function saveVariants(
  videoId: string,
  type: 'image' | 'video',
  variants: { r2_key: string; score?: number; idx: number }[]
): Promise<void> {
  const rows = variants.map(v => ({
    video_id: videoId,
    type,
    variant_idx: v.idx,
    r2_key: v.r2_key,
    score: v.score ?? null,
    is_selected: false,
  }))

  const { error } = await supabaseAdmin
    .from('pipeline_variants')
    .insert(rows)
  if (error) throw new Error(`saveVariants: ${error.message}`)
}

// Get all variants for a video
export async function getVariants(videoId: string): Promise<PipelineVariant[]> {
  const { data, error } = await supabaseAdmin
    .from('pipeline_variants')
    .select('*')
    .eq('video_id', videoId)
    .order('variant_idx')
  if (error) throw new Error(`getVariants: ${error.message}`)
  return data ?? []
}

// Set which variant is selected (deselects others of same type)
export async function selectVariant(videoId: string, variantId: string, type: 'image' | 'video'): Promise<void> {
  // Deselect all variants of this type for this video
  const { error: deselError } = await supabaseAdmin
    .from('pipeline_variants')
    .update({ is_selected: false })
    .eq('video_id', videoId)
    .eq('type', type)
  if (deselError) throw new Error(`selectVariant (deselect): ${deselError.message}`)

  // Select the chosen variant
  const { error: selError } = await supabaseAdmin
    .from('pipeline_variants')
    .update({ is_selected: true })
    .eq('id', variantId)
  if (selError) throw new Error(`selectVariant (select): ${selError.message}`)
}

// Get all runs for a model, most recent first
export async function getModelRuns(modelId: string, limit = 20): Promise<PipelineRun[]> {
  const { data, error } = await supabaseAdmin
    .from('pipeline_runs')
    .select('*')
    .eq('model_id', modelId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`getModelRuns: ${error.message}`)
  return data ?? []
}

// Get all active + inactive models
export async function getAllModels(): Promise<PipelineModel[]> {
  const { data, error } = await supabaseAdmin
    .from('pipeline_models')
    .select('*')
    .order('handle')
  if (error) throw new Error(`getAllModels: ${error.message}`)
  return data ?? []
}

// Update model fields
export async function updateModel(modelId: string, updates: Partial<PipelineModel>): Promise<void> {
  const { error } = await supabaseAdmin
    .from('pipeline_models')
    .update(updates)
    .eq('id', modelId)
  if (error) throw new Error(`updateModel: ${error.message}`)
}

// Create a new pipeline model
export async function createModel(handle: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('pipeline_models')
    .insert({
      handle,
      niche_tags: [],
      kie_ref_urls: [],
      nsfw_flag: false,
      active: true,
      videos_per_cycle: 6,
      flash_frame_enabled: false,
    })
    .select('id')
    .single()
  if (error) throw new Error(`createModel: ${error.message}`)
  return data.id
}

// Load approved suggestions from trends_suggestions for a model (joined with trends_posts for context)
export async function getApprovedSuggestions(handle: string): Promise<Array<{
  id: string
  what_to_change: string
  post_id: string
  fansly_post_id: string
  creator_username: string
  likes_current: number
  text_mode: 'original' | 'none' | 'custom' | null
  custom_text: string | null
  footage_type: 'ai' | 'own' | null
  own_footage_r2_key: string | null
  thumbnail_r2_key: string | null
}>> {
  // trends_suggestions links to trends_models (not pipeline_models); look up model_id first
  const { data: trendModel } = await supabaseAdmin
    .from('trends_models')
    .select('id')
    .eq('fansly_username', handle)
    .single()

  if (!trendModel) return []

  const { data, error } = await supabaseAdmin
    .from('trends_suggestions')
    .select(`
      id,
      what_to_change,
      post_id,
      text_mode,
      custom_text,
      footage_type,
      own_footage_r2_key,
      trends_posts!inner (
        fansly_post_id,
        creator_username,
        likes_current,
        thumbnail_r2_key
      )
    `)
    .eq('model_id', trendModel.id)
    .eq('status', 'approved')
    .order('created_at', { ascending: true })

  if (error) throw new Error(`getApprovedSuggestions: ${error.message}`)

  return (data ?? []).map((row: any) => ({
    id: row.id,
    what_to_change: row.what_to_change,
    post_id: row.post_id,
    text_mode: row.text_mode ?? null,
    custom_text: row.custom_text ?? null,
    footage_type: row.footage_type ?? null,
    own_footage_r2_key: row.own_footage_r2_key ?? null,
    fansly_post_id: row.trends_posts.fansly_post_id,
    creator_username: row.trends_posts.creator_username,
    likes_current: row.trends_posts.likes_current,
    thumbnail_r2_key: row.trends_posts.thumbnail_r2_key ?? null,
  }))
}

// Mark a suggestion as 'done' (used after a brief is generated from it)
export async function markSuggestionUsed(suggestionId: string): Promise<void> {
  // Keep status as 'approved' so suggestions remain visible — just track usage count
  const { data: row } = await supabaseAdmin
    .from('trends_suggestions')
    .select('times_used')
    .eq('id', suggestionId)
    .single()
  const timesUsed = ((row as unknown as { times_used?: number })?.times_used ?? 0) + 1
  const { error } = await supabaseAdmin
    .from('trends_suggestions')
    .update({ times_used: timesUsed, last_used_at: new Date().toISOString() })
    .eq('id', suggestionId)
  if (error) throw new Error(`markSuggestionUsed: ${error.message}`)
}
