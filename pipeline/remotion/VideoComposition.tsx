import React, { useEffect, useState } from 'react'
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  continueRender,
  delayRender,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
  type CalculateMetadataFunction,
} from 'remotion'
import type { CaptionLine, VideoBrandConfig } from './types'

export type { CaptionLine, VideoBrandConfig }

export interface VideoCompositionProps {
  videoSrc: string
  audioSrc?: string
  captionLines: CaptionLine[]
  brandConfig: VideoBrandConfig | null
  durationSec: number
}

export const calculateMetadata: CalculateMetadataFunction<VideoCompositionProps> = ({ props }) => ({
  durationInFrames: Math.max(1, Math.round(props.durationSec * 30)),
  fps: 30,
  width: 1080,
  height: 1920,
})

// Per-word styling from the model's brand pack. Effects compose:
//   outline    → 4-way offset shadow in color_shadow (the classic legibility outline)
//   glow       → soft accent-colored halo layers
//   drop-shadow→ soft dark drop
//   gradient-fill → text gradient (color_text → color_accent) via background-clip; shadows
//                   switch to filter:drop-shadow (textShadow looks muddy under clipped text)
// No effects array in the config → classic outline + drop-shadow (pre-Wave-B look).
export function buildWordStyle(brandConfig: VideoBrandConfig | null, sizeOverride?: number, effectsOverride?: string[]): React.CSSProperties {
  const textColor = brandConfig?.color_text || '#ffffff'
  const shadowColor = brandConfig?.color_shadow || '#000000'
  const accent = brandConfig?.color_accent || textColor
  const effects = effectsOverride ?? brandConfig?.effects ?? ['outline', 'drop-shadow']

  const fallback = brandConfig?.font_fallback ? `"${brandConfig.font_fallback}", ` : ''
  const fontFamily = brandConfig?.font_primary
    ? `"${brandConfig.font_primary}", ${fallback}"Arial Black", sans-serif`
    : '"Arial Black", sans-serif'
  const fontWeight = parseInt(brandConfig?.font_weight ?? '700', 10) || 700
  const fontStyle = brandConfig?.font_style === 'italic' ? 'italic' : 'normal'

  const gradientFill = effects.includes('gradient-fill')
  const shadows: string[] = []
  if (effects.includes('outline')) {
    shadows.push(`-3px -3px 0 ${shadowColor}`, `3px -3px 0 ${shadowColor}`, `-3px 3px 0 ${shadowColor}`, `3px 3px 0 ${shadowColor}`)
  }
  if (effects.includes('glow')) {
    shadows.push(`0 0 24px ${accent}`, `0 0 56px ${accent}`)
  }
  if (effects.includes('drop-shadow')) {
    shadows.push(`0 4px 12px rgba(0,0,0,0.8)`)
  }

  const style: React.CSSProperties = {
    display: 'inline-block',
    fontSize: sizeOverride ?? 72,
    fontFamily,
    fontWeight,
    fontStyle,
    color: textColor,
    lineHeight: 1.15,
  }
  if (gradientFill) {
    style.backgroundImage = `linear-gradient(180deg, ${textColor} 30%, ${accent} 100%)`
    style.WebkitBackgroundClip = 'text'
    style.backgroundClip = 'text'
    style.color = 'transparent'
    style.filter = `drop-shadow(0 3px 3px ${shadowColor}) drop-shadow(0 4px 12px rgba(0,0,0,0.7))` +
      (effects.includes('glow') ? ` drop-shadow(0 0 18px ${accent})` : '')
  } else if (shadows.length > 0) {
    style.textShadow = shadows.join(', ')
  }
  return style
}

function WordStagger({
  words,
  startFrame,
  windowFrames,
  brandConfig,
}: {
  words: string[]
  startFrame: number
  windowFrames: number
  brandConfig: VideoBrandConfig | null
}) {
  const frame = useCurrentFrame()
  const wordStyle = buildWordStyle(brandConfig)

  // Stagger uses 70% of the caption window so all words finish well before it ends.
  // Single-word captions get no stagger (instant).
  const staggerDelay = words.length > 1
    ? Math.max(1, Math.floor((windowFrames * 0.7) / words.length))
    : 0
  const fadeDuration = Math.min(12, Math.max(4, staggerDelay))

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'center',
        gap: '1.2em',
        padding: '0 40px',
      }}
    >
      {words.map((word, wi) => {
        const wordFrame = startFrame + wi * staggerDelay
        const opacity = interpolate(frame, [wordFrame, wordFrame + fadeDuration], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
        return (
          <span key={wi} style={{ ...wordStyle, opacity }}>
            {word}
          </span>
        )
      })}
    </div>
  )
}

// Very-slight per-model color grade (user: "barely noticeable"). filter_css wins; otherwise a
// subtle derived grade. Applied to the video layer only — captions/overlays stay unfiltered.
export function brandVideoFilter(brandConfig: VideoBrandConfig | null): string | undefined {
  if (brandConfig?.filter_css) return brandConfig.filter_css
  if (brandConfig?.color_accent) return 'saturate(1.06) contrast(1.03)'
  return undefined
}

// ~5%-opacity accent tint, top and bottom — cheap "graded, not raw" feel.
export function AccentTint({ brandConfig }: { brandConfig: VideoBrandConfig | null }) {
  const accent = brandConfig?.color_accent
  if (!accent) return null
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(180deg, ${accent}0D 0%, transparent 35%, transparent 70%, ${accent}0A 100%)`,
        pointerEvents: 'none',
      }}
    />
  )
}

export const VideoComposition: React.FC<VideoCompositionProps> = ({
  videoSrc,
  audioSrc,
  captionLines,
  brandConfig,
  durationSec,
}) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const [fontHandle] = useState(() => delayRender('Loading font'))

  useEffect(() => {
    const families = [brandConfig?.font_primary, brandConfig?.font_fallback].filter(Boolean) as string[]
    if (families.length === 0) {
      continueRender(fontHandle)
      return
    }

    // The Google Fonts CSS2 API returns HTTP 400 for the WHOLE request when a family lacks a
    // requested weight (e.g. Pirata One is 400-only), so the old hardcoded ':wght@400;700'
    // silently killed the font AND ate the full 4s delayRender stall. Load in two independent
    // <style> imports per family: a bare one (always valid) + a best-effort weighted one.
    const weight = brandConfig?.font_weight && brandConfig.font_weight !== '400' ? brandConfig.font_weight : null
    for (const family of families) {
      const plus = family.replace(/ /g, '+')
      const bare = document.createElement('style')
      bare.textContent = `@import url('https://fonts.googleapis.com/css2?family=${plus}&display=swap');`
      document.head.appendChild(bare)
      if (weight) {
        const weighted = document.createElement('style')
        weighted.textContent = `@import url('https://fonts.googleapis.com/css2?family=${plus}:wght@${weight}&display=swap');`
        document.head.appendChild(weighted)
      }
    }

    const timer = setTimeout(() => continueRender(fontHandle), 4000)
    document.fonts.ready.then(() => {
      clearTimeout(timer)
      continueRender(fontHandle)
    })

    return () => clearTimeout(timer)
  }, [fontHandle, brandConfig?.font_primary, brandConfig?.font_fallback, brandConfig?.font_weight])

  const totalFrames = Math.max(1, Math.round(durationSec * fps))

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* Background video — OffthreadVideo extracts frames via ffmpeg (frame-accurate, no Chrome seek artifacts) */}
      <OffthreadVideo
        src={videoSrc}
        style={{ width: '100%', height: '100%', objectFit: 'cover', filter: brandVideoFilter(brandConfig) }}
      />

      {/* Very-slight per-brand color grade tint (below captions) */}
      <AccentTint brandConfig={brandConfig} />

      {/* Trending post audio */}
      {audioSrc && <Audio src={audioSrc} />}

      {/* Caption lines — sequential: each replaces the previous */}
      {captionLines.map((line, i) => {
        const startFrame = Math.round(line.startSec * fps)
        const endFrame =
          i + 1 < captionLines.length
            ? Math.round(captionLines[i + 1].startSec * fps)
            : totalFrames
        if (frame < startFrame || frame >= endFrame) return null
        const words = line.text.split(' ').filter(Boolean)
        const windowFrames = endFrame - startFrame
        return (
          <AbsoluteFill
            key={i}
            style={{
              justifyContent: 'flex-end',
              alignItems: 'center',
              paddingBottom: '18%',
              flexDirection: 'column',
            }}
          >
            <WordStagger words={words} startFrame={startFrame} windowFrames={windowFrames} brandConfig={brandConfig} />
          </AbsoluteFill>
        )
      })}

    </AbsoluteFill>
  )
}
