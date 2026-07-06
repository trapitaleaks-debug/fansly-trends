// Overlay element renderers shared by all layouts. Everything is DETERMINISTIC —
// remotion's random(seed) only, never Math.random (renders must be frame-reproducible).
import React from 'react'
import { AbsoluteFill, Img, interpolate, random, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import type { TemplateOverlaySpec } from '../types'

function pct(v: number | undefined, fallback: number): string {
  return `${v ?? fallback}%`
}

function BounceIn({ children, delayFrames = 6 }: { children: React.ReactNode; delayFrames?: number }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const scale = spring({ frame: frame - delayFrames, fps, config: { damping: 9, stiffness: 160, mass: 0.8 } })
  return <div style={{ transform: `scale(${scale})`, transformOrigin: 'center' }}>{children}</div>
}

function Pulse({ children }: { children: React.ReactNode }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const scale = 1 + 0.04 * Math.sin((frame / fps) * Math.PI * 2)
  return <div style={{ transform: `scale(${scale})` }}>{children}</div>
}

function ImageOverlay({ spec, src }: { spec: TemplateOverlaySpec; src: string }) {
  const img = <Img src={src} style={{ width: '100%', height: 'auto' }} />
  const wrapped = spec.anim === 'bounce-in' ? <BounceIn>{img}</BounceIn> : spec.anim === 'pulse' ? <Pulse>{img}</Pulse> : img
  return (
    <div style={{ position: 'absolute', left: pct(spec.x, 10), top: pct(spec.y, 10), width: pct(spec.w, 30) }}>
      {wrapped}
    </div>
  )
}

// SVG arrow sweeping from from_deg to to_deg around a pivot (cortisol-meter style).
function ArrowOverlay({ spec }: { spec: TemplateOverlaySpec }) {
  const frame = useCurrentFrame()
  const { fps, durationInFrames } = useVideoConfig()
  const sweepEnd = Math.min(durationInFrames, Math.round(fps * 1.6))
  const progress = spring({ frame, fps, durationInFrames: sweepEnd, config: { damping: 11, stiffness: 90 } })
  const deg = interpolate(progress, [0, 1], [spec.from_deg ?? -60, spec.to_deg ?? 60])
  const px = spec.pivot?.x ?? 50
  const py = spec.pivot?.y ?? 20
  return (
    <div style={{ position: 'absolute', left: `${px}%`, top: `${py}%`, transform: `rotate(${deg}deg)`, transformOrigin: 'bottom center' }}>
      <svg width={26} height={190} viewBox="0 0 26 190">
        <polygon points="13,0 26,34 17,34 17,190 9,190 9,34 0,34" fill="#e11d48" stroke="#7f1d1d" strokeWidth={2} />
      </svg>
    </div>
  )
}

// Floating hearts bokeh — seeded drift upward with wobble and fade (dreamy overlay style).
function HeartsOverlay({ spec, accent }: { spec: TemplateOverlaySpec; accent: string }) {
  const frame = useCurrentFrame()
  const { durationInFrames, height } = useVideoConfig()
  const count = Math.round(14 * (spec.density ?? 0.5) * 2)
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {Array.from({ length: count }, (_, i) => {
        const seed = `heart-${i}`
        const x0 = random(seed + 'x') * 100
        const size = 26 + random(seed + 's') * 44
        const speed = 0.35 + random(seed + 'v') * 0.55
        const phase = random(seed + 'p') * durationInFrames
        const t = (frame + phase) % durationInFrames
        const y = 105 - (t * speed * 100) / height * 6
        const wobble = Math.sin((t / 30) * Math.PI * 2 + i) * 3
        const opacity = interpolate(y, [-5, 20, 85, 105], [0, 0.7, 0.8, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
        return (
          <div key={i} style={{ position: 'absolute', left: `${x0 + wobble}%`, top: `${y}%`, fontSize: size, opacity, filter: `blur(${random(seed + 'b') * 1.5}px) drop-shadow(0 0 10px ${accent})` }}>
            💗
          </div>
        )
      })}
    </AbsoluteFill>
  )
}

// Twinkling sparkles — seeded positions, sinusoidal shimmer.
function SparklesOverlay({ spec, accent }: { spec: TemplateOverlaySpec; accent: string }) {
  const frame = useCurrentFrame()
  const count = Math.round(18 * (spec.density ?? 0.5) * 2)
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {Array.from({ length: count }, (_, i) => {
        const seed = `spark-${i}`
        const x = random(seed + 'x') * 100
        const y = random(seed + 'y') * 100
        const size = 14 + random(seed + 's') * 22
        const phase = random(seed + 'p') * 60
        const opacity = 0.25 + 0.75 * Math.abs(Math.sin((frame + phase) / 17))
        return (
          <div key={i} style={{ position: 'absolute', left: `${x}%`, top: `${y}%`, fontSize: size, opacity, filter: `drop-shadow(0 0 8px ${accent})` }}>
            ✦
          </div>
        )
      })}
    </AbsoluteFill>
  )
}

// Periodic RGB-split glitch slabs — fires in short deterministic bursts.
function GlitchOverlay({ spec }: { spec: TemplateOverlaySpec }) {
  const frame = useCurrentFrame()
  const burst = frame % 75
  if (burst > 8) return null
  const slabs = Math.round(4 * (spec.density ?? 0.5) * 2)
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', mixBlendMode: 'screen' }}>
      {Array.from({ length: slabs }, (_, i) => {
        const seed = `glitch-${Math.floor(frame / 75)}-${i}`
        const y = random(seed + 'y') * 100
        const h = 1 + random(seed + 'h') * 4
        const dx = (random(seed + 'x') - 0.5) * 40
        const color = i % 2 === 0 ? 'rgba(255,0,80,0.35)' : 'rgba(0,220,255,0.35)'
        return <div key={i} style={{ position: 'absolute', top: `${y}%`, left: dx, width: '110%', height: `${h}%`, background: color }} />
      })}
    </AbsoluteFill>
  )
}

export function OverlayStack({
  overlays,
  assetUrls,
  stickerUrl,
  accent,
}: {
  overlays: TemplateOverlaySpec[]
  assetUrls: Record<string, string>
  stickerUrl?: string
  accent: string
}) {
  return (
    <>
      {overlays.map((spec, i) => {
        switch (spec.type) {
          case 'image': {
            const src = spec.src ? assetUrls[spec.src] : undefined
            return src ? <ImageOverlay key={i} spec={spec} src={src} /> : null
          }
          case 'sticker':
            return stickerUrl ? <ImageOverlay key={i} spec={{ ...spec, anim: spec.anim ?? 'bounce-in' }} src={stickerUrl} /> : null
          case 'arrow':
            return <ArrowOverlay key={i} spec={spec} />
          case 'hearts':
            return <HeartsOverlay key={i} spec={spec} accent={accent} />
          case 'sparkles':
            return <SparklesOverlay key={i} spec={spec} accent={accent} />
          case 'glitch':
            return <GlitchOverlay key={i} spec={spec} />
          default:
            return null
        }
      })}
    </>
  )
}
