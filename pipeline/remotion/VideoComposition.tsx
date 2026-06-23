import React, { useEffect, useState } from 'react'
import {
  AbsoluteFill,
  Audio,
  Video,
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

function WordStagger({
  words,
  startFrame,
  brandConfig,
}: {
  words: string[]
  startFrame: number
  brandConfig: VideoBrandConfig | null
}) {
  const frame = useCurrentFrame()
  const textColor = brandConfig?.color_text || '#ffffff'
  const shadowColor = brandConfig?.color_shadow || '#000000'

  const fontFamily = brandConfig?.font_primary
    ? `"${brandConfig.font_primary}", "Arial Black", sans-serif`
    : '"Arial Black", sans-serif'

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'center',
        gap: '0.15em',
        padding: '0 40px',
      }}
    >
      {words.map((word, wi) => {
        const wordFrame = startFrame + wi * 3
        const opacity = interpolate(frame, [wordFrame, wordFrame + 8], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
        const translateY = interpolate(frame, [wordFrame, wordFrame + 8], [14, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
        return (
          <span
            key={wi}
            style={{
              display: 'inline-block',
              opacity,
              transform: `translateY(${translateY}px)`,
              fontSize: 72,
              fontFamily,
              fontWeight: 700,
              color: textColor,
              textShadow: [
                `-3px -3px 0 ${shadowColor}`,
                `3px -3px 0 ${shadowColor}`,
                `-3px 3px 0 ${shadowColor}`,
                `3px 3px 0 ${shadowColor}`,
                `0 4px 12px rgba(0,0,0,0.8)`,
              ].join(', '),
              lineHeight: 1.15,
            }}
          >
            {word}
          </span>
        )
      })}
    </div>
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
    const fontName = brandConfig?.font_primary
    if (!fontName) {
      continueRender(fontHandle)
      return
    }

    const style = document.createElement('style')
    style.textContent = `@import url('https://fonts.googleapis.com/css2?family=${fontName.replace(/ /g, '+')}:wght@400;700&display=swap');`
    document.head.appendChild(style)

    const timer = setTimeout(() => continueRender(fontHandle), 4000)
    document.fonts.ready.then(() => {
      clearTimeout(timer)
      continueRender(fontHandle)
    })

    return () => clearTimeout(timer)
  }, [fontHandle, brandConfig?.font_primary])

  const totalFrames = Math.max(1, Math.round(durationSec * fps))
  const hasSticker = !!(brandConfig?.stickers?.[0])
  const stickerEmoji = brandConfig?.stickers?.[0] ?? ''

  // Sticker bounce-in animation
  const stickerScale = interpolate(frame, [3, 12], [0.2, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  const stickerOpacity = interpolate(frame, [3, 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* Background video */}
      <Video
        src={videoSrc}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />

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
            <WordStagger words={words} startFrame={startFrame} brandConfig={brandConfig} />
          </AbsoluteFill>
        )
      })}

      {/* Emoji sticker — top-right corner */}
      {hasSticker && (
        <AbsoluteFill
          style={{
            justifyContent: 'flex-start',
            alignItems: 'flex-end',
            padding: '5% 6%',
          }}
        >
          <span
            style={{
              fontSize: 90,
              fontFamily: '"Noto Color Emoji", sans-serif',
              opacity: stickerOpacity,
              transform: `scale(${stickerScale})`,
              display: 'inline-block',
              transformOrigin: 'center',
              lineHeight: 1,
            }}
          >
            {stickerEmoji}
          </span>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  )
}
