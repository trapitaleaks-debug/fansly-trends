import React, { useEffect, useState } from 'react'
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  continueRender,
  delayRender,
  type CalculateMetadataFunction,
} from 'remotion'
import type { CaptionLine, TemplateInputProps, VideoBrandConfig } from './types'
import { AccentTint, brandVideoFilter, buildWordStyle, CaptionTrack } from './layouts/shared'
import { MemeSlotLayout } from './layouts/MemeSlotLayout'
import { OverlayElementsLayout } from './layouts/OverlayElementsLayout'
import { OverlayStack } from './layouts/overlays'

export type { CaptionLine, VideoBrandConfig }
export { buildWordStyle, brandVideoFilter }

export interface VideoCompositionProps {
  videoSrc: string
  audioSrc?: string
  captionLines: CaptionLine[]
  brandConfig: VideoBrandConfig | null
  durationSec: number
  clipDurationSec?: number
  template?: TemplateInputProps
}

export const calculateMetadata: CalculateMetadataFunction<VideoCompositionProps> = ({ props }) => ({
  durationInFrames: Math.max(1, Math.round(props.durationSec * 30)),
  fps: 30,
  width: 1080,
  height: 1920,
})

// Classic caption layout — the pre-template default (template_id NULL renders exactly this).
function CaptionLayout({
  videoSrc,
  audioSrc,
  captionLines,
  brandConfig,
  durationSec,
  template,
}: VideoCompositionProps) {
  const accent = brandConfig?.color_accent || '#f472b6'
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* Background video — OffthreadVideo extracts frames via ffmpeg (frame-accurate, no Chrome seek artifacts) */}
      <OffthreadVideo
        src={videoSrc}
        style={{ width: '100%', height: '100%', objectFit: 'cover', filter: template?.manifest.filter_css ?? brandVideoFilter(brandConfig) }}
      />

      {/* Very-slight per-brand color grade tint (below captions) */}
      <AccentTint brandConfig={brandConfig} />

      {/* Trending post audio */}
      {audioSrc && <Audio src={audioSrc} />}

      {/* Caption lines — sequential word-stagger, bottom zone */}
      <CaptionTrack
        captionLines={captionLines}
        durationSec={durationSec}
        brandConfig={brandConfig}
        textSpec={template?.manifest.text}
        stagger
      />

      {/* Optional decorative overlays on caption templates (hearts, sparkles, glitch, sticker) */}
      {template?.manifest.overlays && (
        <OverlayStack overlays={template.manifest.overlays} assetUrls={template.assetUrls} stickerUrl={template.stickerUrl} accent={accent} />
      )}
    </AbsoluteFill>
  )
}

export const VideoComposition: React.FC<VideoCompositionProps> = (props) => {
  const { brandConfig, template } = props
  const [fontHandle] = useState(() => delayRender('Loading font'))

  useEffect(() => {
    const families: Array<{ family: string; weights: number[] }> = []
    if (brandConfig?.font_primary) {
      const w = parseInt(brandConfig.font_weight ?? '', 10)
      families.push({ family: brandConfig.font_primary, weights: w && w !== 400 ? [w] : [] })
    }
    if (brandConfig?.font_fallback) families.push({ family: brandConfig.font_fallback, weights: [] })
    if (template?.manifest.text?.font_role === 'display' && template.manifest.text.font_family) {
      families.push({ family: template.manifest.text.font_family, weights: template.manifest.text.font_weights?.filter(w => w !== 400) ?? [] })
    }
    if (families.length === 0) {
      continueRender(fontHandle)
      return
    }

    // The Google Fonts CSS2 API returns HTTP 400 for the WHOLE request when a family lacks a
    // requested weight (e.g. Pirata One is 400-only), so the old hardcoded ':wght@400;700'
    // silently killed the font AND ate the full 4s delayRender stall. Load in two independent
    // <style> imports per family: a bare one (always valid) + best-effort weighted ones.
    for (const { family, weights } of families) {
      const plus = family.replace(/ /g, '+')
      const bare = document.createElement('style')
      bare.textContent = `@import url('https://fonts.googleapis.com/css2?family=${plus}&display=swap');`
      document.head.appendChild(bare)
      for (const w of weights) {
        const weighted = document.createElement('style')
        weighted.textContent = `@import url('https://fonts.googleapis.com/css2?family=${plus}:wght@${w}&display=swap');`
        document.head.appendChild(weighted)
      }
    }

    const timer = setTimeout(() => continueRender(fontHandle), 4000)
    document.fonts.ready.then(() => {
      clearTimeout(timer)
      continueRender(fontHandle)
    })

    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontHandle, brandConfig?.font_primary, brandConfig?.font_fallback, brandConfig?.font_weight])

  switch (template?.manifest.layout) {
    case 'meme-slot':
      return <MemeSlotLayout {...props} template={template} />
    case 'overlay-elements':
      return <OverlayElementsLayout {...props} template={template} />
    default:
      return <CaptionLayout {...props} />
  }
}
