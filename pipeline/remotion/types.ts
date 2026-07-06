// Shared types for Remotion composition — imported by remotion-renderer.ts (ts-node)
// and VideoComposition.tsx (webpack). No React imports here.

export interface CaptionLine {
  text: string
  startSec: number
}

export interface VideoBrandConfig {
  font_primary?: string
  font_weight?: string
  font_style?: string
  font_fallback?: string
  color_text?: string
  color_accent?: string
  color_shadow?: string
  effects?: string[] // 'glow' | 'outline' | 'drop-shadow' | 'gradient-fill'
  stickers?: string[]
  animation_duration_ms?: number
  filter_css?: string // very-slight per-model video color grade; derived from color_accent when absent
}

// ─── Template system (Wave B) ────────────────────────────────────────────────────────────────

export type TemplateLayout = 'caption' | 'meme-slot' | 'overlay-elements'

export interface TemplateTextSpec {
  zone?: 'bottom' | 'top'
  font_role?: 'brand' | 'display'
  font_family?: string // Google Fonts family (display role)
  font_weights?: number[] // weights to request — prevents the 400-only @import bug
  size?: number
  effects?: string[] // overrides brandConfig.effects for this template
  color_text?: string
  color_accent?: string
}

export interface TemplateSlotSpec {
  x: number // percent of 1080×1920 canvas
  y: number
  w: number
  h: number
  shape?: 'rect' | 'circle'
  frame_asset?: string // R2 key → hole-punch PNG rendered ABOVE the clip
  fg_asset?: string // R2 key → VP9-alpha webm rendered topmost
  fg_duration_sec?: number // required with fg_asset (drives <Loop>)
  bg_color?: string
}

export interface TemplateOverlaySpec {
  type: 'image' | 'arrow' | 'sticker' | 'hearts' | 'sparkles' | 'glitch'
  src?: string // R2 key (image)
  x?: number
  y?: number
  w?: number
  anim?: 'none' | 'bounce-in' | 'pulse'
  from_deg?: number // arrow
  to_deg?: number
  pivot?: { x: number; y: number }
  density?: number // particles
}

export interface TemplateManifest {
  layout: TemplateLayout
  duration_sec?: number
  text?: TemplateTextSpec
  fixed_lines?: string[]
  slot?: TemplateSlotSpec
  overlays?: TemplateOverlaySpec[]
  filter_css?: string
}

// Passed via inputProps — asset R2 keys already resolved to local-server http URLs.
export interface TemplateInputProps {
  manifest: TemplateManifest
  assetUrls: Record<string, string> // manifest R2 key → http://127.0.0.1:<port>/tpl_N.ext
  stickerUrl?: string
}
