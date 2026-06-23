// Shared types for Remotion composition — imported by remotion-renderer.ts (ts-node)
// and VideoComposition.tsx (webpack). No React imports here.

export interface CaptionLine {
  text: string
  startSec: number
}

export interface VideoBrandConfig {
  font_primary?: string
  color_text?: string
  color_shadow?: string
  effects?: string[]
  stickers?: string[]
  animation_duration_ms?: number
}
