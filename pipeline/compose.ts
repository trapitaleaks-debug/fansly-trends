/**
 * Hyperframes HTML composition generator.
 * Produces a self-contained HTML file that Hyperframes renders to MP4.
 * Replaces ffmpeg drawtext — browser renders text with proper anti-aliasing,
 * emoji support, CSS positioning, and optional GSAP animations.
 */

const GSAP_CDN = 'https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js'

export interface CompositionOpts {
  videoFile: string       // relative filename in the same tmpDir (e.g. "slot1_raw.mp4")
  overlayText?: string | null
  duration: number
  slot: number
  width?: number
  height?: number
}

export function buildComposition(opts: CompositionOpts): string {
  const { videoFile, overlayText, duration, slot, width = 720, height = 1280 } = opts
  const id = `slot${slot}`
  const text = overlayText?.trim() ?? ''

  // Split long text at nearest word boundary around the midpoint
  const MAX_CHARS = 36
  let textLines: string[] = []
  if (text) {
    if (text.length <= MAX_CHARS) {
      textLines = [text]
    } else {
      const mid = Math.floor(text.length / 2)
      let splitIdx = -1
      for (let i = mid; i < text.length; i++) {
        if (text[i] === ' ') { splitIdx = i; break }
      }
      if (splitIdx === -1) {
        for (let i = mid; i >= 0; i--) {
          if (text[i] === ' ') { splitIdx = i; break }
        }
      }
      if (splitIdx === -1) splitIdx = mid
      textLines = [text.slice(0, splitIdx).trim(), text.slice(splitIdx).trim()]
    }
  }

  const overlayHtml = textLines.length > 0 ? `
  <div id="overlay-${id}" class="clip" data-start="0" data-duration="${duration.toFixed(2)}" data-track-index="2">
    ${textLines.map(l => `<p>${escapeHtml(l)}</p>`).join('\n    ')}
  </div>` : ''

  const overlayAnim = textLines.length > 0 ? `
    tl.fromTo('#overlay-${id}',
      { opacity: 0, y: -10 },
      { opacity: 1, y: 0, duration: 0.28, ease: 'power2.out' },
      0.2
    );` : ''

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=${width}, height=${height}">
  <meta data-composition-id="${id}" data-width="${width}" data-height="${height}">
  <script src="${GSAP_CDN}"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #000; margin: 0; padding: 0; }
    .clip { position: absolute; top: 0; left: 0; visibility: hidden; }
    #video-${id} { width: ${width}px; height: ${height}px; object-fit: cover; }
    #overlay-${id} {
      width: ${width}px;
      top: ${Math.round(height * 0.12)}px;
      padding: 0 28px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
    }
    #overlay-${id} p {
      margin: 0;
      font-family: 'Liberation Sans', 'Arial Black', Arial, sans-serif;
      font-size: 60px;
      font-weight: 900;
      color: #fff;
      text-align: center;
      line-height: 1.15;
      -webkit-text-stroke: 5px #000;
      paint-order: stroke fill;
      letter-spacing: -0.5px;
    }
  </style>
</head>
<body>
  <video
    id="video-${id}"
    class="clip"
    data-start="0"
    data-duration="${duration.toFixed(2)}"
    data-track-index="0"
    src="${videoFile}"
    muted
    playsinline
  ></video>${overlayHtml}
  <script>
    var tl = gsap.timeline({ paused: true });
    tl.to('#video-${id}', { opacity: 1, duration: 0.01 }, 0);${overlayAnim}
    window.__timelines = window.__timelines || {};
    window.__timelines['${id}'] = tl;
  </script>
</body>
</html>`
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
