// Overlay layout: the model clip fullscreen with designed elements on top
// (cortisol-meter style: gauge image + animated arrow + sticker), plus the normal
// bottom caption track and the brand color grade.
import React from 'react'
import { AbsoluteFill, Audio, Loop, OffthreadVideo, useVideoConfig } from 'remotion'
import type { CaptionLine, TemplateInputProps, VideoBrandConfig } from '../types'
import { AccentTint, brandVideoFilter, CaptionTrack } from './shared'
import { OverlayStack } from './overlays'

export function OverlayElementsLayout({
  videoSrc,
  audioSrc,
  captionLines,
  brandConfig,
  durationSec,
  clipDurationSec,
  template,
  emojiImages,
}: {
  videoSrc: string
  audioSrc?: string
  captionLines: CaptionLine[]
  brandConfig: VideoBrandConfig | null
  durationSec: number
  clipDurationSec?: number
  template: TemplateInputProps
  emojiImages?: Record<string, string>
}) {
  const { fps } = useVideoConfig()
  const m = template.manifest
  const accent = brandConfig?.color_accent || '#f472b6'

  const clipFrames = Math.max(1, Math.round((clipDurationSec ?? durationSec) * fps))
  const needsLoop = clipDurationSec != null && clipDurationSec < durationSec - 0.05
  const clipVideo = (
    <OffthreadVideo
      src={videoSrc}
      muted
      style={{ width: '100%', height: '100%', objectFit: 'cover', filter: m.filter_css ?? brandVideoFilter(brandConfig) }}
    />
  )

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {needsLoop ? <Loop durationInFrames={clipFrames}>{clipVideo}</Loop> : clipVideo}
      <AccentTint brandConfig={brandConfig} />

      {m.overlays && <OverlayStack overlays={m.overlays} assetUrls={template.assetUrls} stickerUrl={template.stickerUrl} accent={accent} />}

      <CaptionTrack
        captionLines={captionLines}
        durationSec={durationSec}
        brandConfig={brandConfig}
        textSpec={m.text}
        stagger
        emojiImages={emojiImages}
      />

      {audioSrc && <Audio src={audioSrc} />}
    </AbsoluteFill>
  )
}
