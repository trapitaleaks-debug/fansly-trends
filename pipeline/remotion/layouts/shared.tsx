// Shared text rendering for all layouts: brand-aware word styling, the word-stagger
// animation, and the sequential caption track (lines replace each other, |N% timing
// already resolved to startSec server-side).
import React from 'react'
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import type { CaptionLine, TemplateTextSpec, VideoBrandConfig } from '../types'

// Per-word styling from the model's brand pack. Effects compose:
//   outline    → 4-way offset shadow in color_shadow (the classic legibility outline)
//   glow       → soft accent-colored halo layers
//   drop-shadow→ soft dark drop
//   gradient-fill → text gradient (color_text → color_accent) via background-clip; shadows
//                   switch to filter:drop-shadow (textShadow looks muddy under clipped text)
// No effects array in the config → classic outline + drop-shadow (pre-Wave-B look).
export function buildWordStyle(
  brandConfig: VideoBrandConfig | null,
  textSpec?: TemplateTextSpec | null,
): React.CSSProperties {
  const textColor = textSpec?.color_text || brandConfig?.color_text || '#ffffff'
  const shadowColor = brandConfig?.color_shadow || '#000000'
  const accent = textSpec?.color_accent || brandConfig?.color_accent || textColor
  const effects = textSpec?.effects ?? brandConfig?.effects ?? ['outline', 'drop-shadow']

  const useDisplayFont = textSpec?.font_role === 'display' && textSpec.font_family
  const fallback = brandConfig?.font_fallback ? `"${brandConfig.font_fallback}", ` : ''
  // "Noto Color Emoji" at the end: without it Linux Chrome renders emojis in an ancient
  // monochrome fallback ("90s emojis" — user complaint). Loaded in the composition font effect.
  const fontFamily = useDisplayFont
    ? `"${textSpec!.font_family}", "Arial Black", sans-serif, "Noto Color Emoji"`
    : brandConfig?.font_primary
      ? `"${brandConfig.font_primary}", ${fallback}"Arial Black", sans-serif, "Noto Color Emoji"`
      : '"Arial Black", sans-serif, "Noto Color Emoji"'
  const fontWeight = useDisplayFont
    ? (textSpec?.font_weights?.[textSpec.font_weights.length - 1] ?? 400)
    : parseInt(brandConfig?.font_weight ?? '700', 10) || 700
  const fontStyle = !useDisplayFont && brandConfig?.font_style === 'italic' ? 'italic' : 'normal'

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
    fontSize: textSpec?.size ?? 72,
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

export function WordStagger({
  words,
  startFrame,
  windowFrames,
  brandConfig,
  textSpec,
  emojiImages,
}: {
  words: string[]
  startFrame: number
  windowFrames: number
  brandConfig: VideoBrandConfig | null
  textSpec?: TemplateTextSpec | null
  emojiImages?: Record<string, string>
}) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const wordStyle = buildWordStyle(brandConfig, textSpec)
  // Per-model entrance from the brand pack (was ignored pre-Wave-B): slide-up | pop-in |
  // typewriter (→fade) | fade default. Visible motion, not just opacity.
  const anim = brandConfig?.animation_primary ?? 'fade'

  // Stagger uses 70% of the caption window so all words finish well before it ends.
  // Single-word captions get no stagger (instant).
  const staggerDelay = words.length > 1
    ? Math.max(1, Math.floor((windowFrames * 0.7) / words.length))
    : 0
  const fadeDuration = Math.min(12, Math.max(4, staggerDelay))

  return (
    // ~11% side margins — long captions wrap to a new centered line instead of hugging the
    // video borders (user feedback, round 3).
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: '1.2em', padding: '0 120px' }}>
      {words.map((word, wi) => {
        const wordFrame = startFrame + wi * staggerDelay
        const opacity = interpolate(frame, [wordFrame, wordFrame + fadeDuration], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
        let transform: string | undefined
        if (anim === 'slide-up') {
          const y = interpolate(frame, [wordFrame, wordFrame + fadeDuration + 4], [46, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          })
          transform = `translateY(${y}px)`
        } else if (anim === 'pop-in') {
          const s = spring({ frame: frame - wordFrame, fps, config: { damping: 10, stiffness: 180, mass: 0.6 } })
          transform = `scale(${Math.max(0.001, s)})`
        }
        return (
          <span key={wi} style={{ ...wordStyle, opacity, transform, transformOrigin: 'center bottom' }}>
            <EmojiText text={word} emojiImages={emojiImages} />
          </span>
        )
      })}
    </div>
  )
}

// Render text with Apple emoji images swapped in for emoji characters. The emoji→dataURI map
// is computed server-side (lib/apple-emoji.ts) and passed via inputProps; here we only do a
// longest-match split against the map's keys (browser-safe, no node deps).
export function EmojiText({ text, emojiImages }: { text: string; emojiImages?: Record<string, string> }) {
  if (!emojiImages || Object.keys(emojiImages).length === 0) return <>{text}</>
  const keys = Object.keys(emojiImages).sort((a, b) => b.length - a.length)
  const parts: React.ReactNode[] = []
  let rest = text
  let k = 0
  while (rest.length > 0) {
    let idx = -1
    let hit = ''
    for (const key of keys) {
      const i = rest.indexOf(key)
      if (i !== -1 && (idx === -1 || i < idx)) { idx = i; hit = key }
    }
    if (idx === -1) { parts.push(rest); break }
    if (idx > 0) parts.push(rest.slice(0, idx))
    parts.push(
      <img
        key={k++}
        src={emojiImages[hit]}
        alt={hit}
        style={{ height: '1.02em', width: 'auto', verticalAlign: '-0.14em', display: 'inline-block' }}
      />
    )
    rest = rest.slice(idx + hit.length)
  }
  return <>{parts}</>
}

// Sequential caption track: line i shows from its startSec until the next line's start.
// stagger=false renders each line as one block with a quick fade (meme/static text).
export function CaptionTrack({
  captionLines,
  durationSec,
  brandConfig,
  textSpec,
  stagger = true,
  emojiImages,
}: {
  captionLines: CaptionLine[]
  durationSec: number
  brandConfig: VideoBrandConfig | null
  textSpec?: TemplateTextSpec | null
  stagger?: boolean
  emojiImages?: Record<string, string>
}) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const totalFrames = Math.max(1, Math.round(durationSec * fps))
  const zone = textSpec?.zone ?? 'bottom'

  return (
    <>
      {captionLines.map((line, i) => {
        const startFrame = Math.round(line.startSec * fps)
        const endFrame = i + 1 < captionLines.length ? Math.round(captionLines[i + 1].startSec * fps) : totalFrames
        if (frame < startFrame || frame >= endFrame) return null
        const words = line.text.split(' ').filter(Boolean)
        const windowFrames = endFrame - startFrame
        const fade = interpolate(frame, [startFrame, startFrame + 6], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
        return (
          <AbsoluteFill
            key={i}
            style={{
              justifyContent: zone === 'top' ? 'flex-start' : 'flex-end',
              alignItems: 'center',
              paddingBottom: zone === 'bottom' ? '18%' : undefined,
              paddingTop: zone === 'top' ? '8%' : undefined,
              flexDirection: 'column',
            }}
          >
            {stagger ? (
              <WordStagger words={words} startFrame={startFrame} windowFrames={windowFrames} brandConfig={brandConfig} textSpec={textSpec} emojiImages={emojiImages} />
            ) : (
              <div style={{ opacity: fade, textAlign: 'center', padding: '0 120px' }}>
                <span style={buildWordStyle(brandConfig, textSpec)}>
                  <EmojiText text={line.text} emojiImages={emojiImages} />
                </span>
              </div>
            )}
          </AbsoluteFill>
        )
      })}
    </>
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
