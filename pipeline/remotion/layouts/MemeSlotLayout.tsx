// Meme layout: a designed frame with a media slot for the model's clip.
// Composition order (back → front): bg_color → model clip at slot rect → frame_asset
// (hole-punch PNG covering everything except the slot) → fg_asset (VP9-alpha webm, e.g.
// the bear-trap snap / CJ walk-in) → text zones → overlays.
import React from 'react'
import { AbsoluteFill, Audio, Img, Loop, OffthreadVideo, useCurrentFrame, useVideoConfig } from 'remotion'
import type { CaptionLine, TemplateInputProps, VideoBrandConfig } from '../types'
import { buildWordStyle, EmojiText } from './shared'
import { OverlayStack } from './overlays'

export function MemeSlotLayout({
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
  const slot = m.slot ?? { x: 10, y: 25, w: 80, h: 50, shape: 'rect' as const }
  const accent = brandConfig?.color_accent || '#f472b6'

  // Loop the model clip when it's shorter than the template duration (e.g. 5s clip in a
  // 7.7s bear-trap template).
  const clipFrames = Math.max(1, Math.round((clipDurationSec ?? durationSec) * fps))
  const needsLoop = clipDurationSec != null && clipDurationSec < durationSec - 0.05
  const clipVideo = (
    <OffthreadVideo src={videoSrc} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
  )

  const frameUrl = m.slot?.frame_asset ? template.assetUrls[m.slot.frame_asset] : undefined
  const fgUrl = m.slot?.fg_asset ? template.assetUrls[m.slot.fg_asset] : undefined
  const fgFrames = Math.max(1, Math.round((m.slot?.fg_duration_sec ?? durationSec) * fps))

  return (
    <AbsoluteFill style={{ backgroundColor: m.slot?.bg_color ?? '#000' }}>
      {/* Model clip inside the slot */}
      <div
        style={{
          position: 'absolute',
          left: `${slot.x}%`,
          top: `${slot.y}%`,
          width: `${slot.w}%`,
          height: `${slot.h}%`,
          overflow: 'hidden',
          borderRadius: slot.shape === 'circle' ? '50%' : undefined,
        }}
      >
        {needsLoop ? <Loop durationInFrames={clipFrames}>{clipVideo}</Loop> : clipVideo}
      </div>

      {/* Hole-punch frame above the clip (the meme artwork with a transparent slot) */}
      {frameUrl && <Img src={frameUrl} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />}

      {/* Animated alpha-webm foreground (trap snap, CJ walk-in) */}
      {fgUrl && (
        <AbsoluteFill>
          <Loop durationInFrames={fgFrames}>
            <OffthreadVideo transparent muted src={fgUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </Loop>
        </AbsoluteFill>
      )}

      {/* Meme text — ALL lines visible simultaneously as a static block (list-meme style),
          quick fade-in. Unlike captions, meme lines never replace each other. */}
      <MemeTextBlock captionLines={captionLines} brandConfig={brandConfig} textSpec={{ zone: 'top', ...m.text }} emojiImages={emojiImages} />

      {m.overlays && <OverlayStack overlays={m.overlays} assetUrls={template.assetUrls} stickerUrl={template.stickerUrl} accent={accent} />}

      {audioSrc && <Audio src={audioSrc} />}
    </AbsoluteFill>
  )
}

function MemeTextBlock({
  captionLines,
  brandConfig,
  textSpec,
  emojiImages,
}: {
  captionLines: CaptionLine[]
  brandConfig: VideoBrandConfig | null
  textSpec: NonNullable<TemplateInputProps['manifest']['text']>
  emojiImages?: Record<string, string>
}) {
  const frame = useCurrentFrame()
  const style = buildWordStyle(brandConfig, textSpec)
  const opacity = Math.min(1, frame / 6)
  const zone = textSpec.zone ?? 'top'
  if (captionLines.length === 0) return null
  return (
    <AbsoluteFill
      style={{
        justifyContent: zone === 'top' ? 'flex-start' : 'flex-end',
        alignItems: textSpec.align === 'left' ? 'flex-start' : 'center',
        paddingTop: zone === 'top' ? '5%' : undefined,
        paddingBottom: zone === 'bottom' ? '8%' : undefined,
        paddingLeft: '6%',
        paddingRight: '6%',
        flexDirection: 'column',
        gap: '0.5em',
        opacity,
      }}
    >
      {captionLines.map((line, i) => (
        <div key={i} style={{ ...style, whiteSpace: 'pre-line', textAlign: textSpec.align === 'left' ? 'left' : 'center' }}>
          <EmojiText text={line.text} emojiImages={emojiImages} />
        </div>
      ))}
    </AbsoluteFill>
  )
}
