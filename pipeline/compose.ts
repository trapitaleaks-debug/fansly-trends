/**
 * Hyperframes HTML composition generator.
 * Structure must match the blank template from node_modules/hyperframes/dist/templates/blank/index.html:
 * - data-composition-id goes on the ROOT div (not a <meta> tag)
 * - Root div carries data-start, data-duration, data-width, data-height
 * - Each timed element: class="clip", data-start, data-duration, data-track-index
 */

const GSAP_CDN = 'https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js'

export interface CompositionOpts {
  videoFile: string
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
  const dur = duration.toFixed(2)

  // Split long text at nearest word boundary
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
      <div id="overlay" class="clip" data-start="0" data-duration="${dur}" data-track-index="1"
           style="position:absolute;top:${Math.round(height * 0.70)}px;left:0;width:${width}px;display:flex;flex-direction:column;align-items:center;gap:2px;padding:0 28px;">
        ${textLines.map(l => `<p style="margin:0;font-family:'Arial Black',Arial,sans-serif;font-size:70px;font-weight:900;color:#fff;text-align:center;line-height:1.15;-webkit-text-stroke:6px #000;paint-order:stroke fill;letter-spacing:-0.5px;">${escapeHtml(l)}</p>`).join('\n        ')}
      </div>` : ''

  const overlayAnim = textLines.length > 0 ? `
    tl.fromTo('#overlay', { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.28, ease: 'power2.out' }, 0.2);` : ''

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=${width}, height=${height}">
  <script src="${GSAP_CDN}"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #000; }
    .clip { position: absolute; top: 0; left: 0; visibility: hidden; }
  </style>
</head>
<body>
  <div id="root"
    data-composition-id="${id}"
    data-start="0"
    data-duration="${dur}"
    data-width="${width}"
    data-height="${height}"
    style="position:relative;width:${width}px;height:${height}px;overflow:hidden;">
    <video
      id="video"
      class="clip"
      src="${videoFile}"
      muted
      playsinline
      data-start="0"
      data-duration="${dur}"
      data-track-index="0"
      style="width:${width}px;height:${height}px;object-fit:cover;"
    ></video>${overlayHtml}
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    tl.to('#video', { opacity: 1, duration: 0.01 }, 0);${overlayAnim}
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

function extractCssBlock(styleContent: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = styleContent.match(new RegExp(esc + '\\s*\\{[\\s\\S]*?\\}'))
  return match?.[0] ?? ''
}

/**
 * Adapts a brand preview HTML file (like liisaofficial-brand-preview.html) into
 * a Hyperframes-compatible composition. Extracts the .word typography from the
 * brand HTML and applies it over the model's own footage.
 */
export function adaptBrandHtmlForRender(
  brandHtml: string,
  videoFile: string,
  overlayText: string,
  duration: number,
  slot: number,
  width = 720,
  height = 1280
): string {
  const id = `slot${slot}`
  const dur = duration.toFixed(2)
  const text = overlayText.trim()

  // Extract Google Fonts <link> tags
  const linkTags = [...brandHtml.matchAll(/<link[^>]*fonts\.googleapis[^>]*>/g)]
    .map(m => m[0]).join('\n  ')

  // Extract .word (and variants) CSS from the brand's <style> block
  const styleMatch = brandHtml.match(/<style>([\s\S]*?)<\/style>/)
  const styleContent = styleMatch?.[1] ?? ''
  const wordCss = extractCssBlock(styleContent, '\\.word')
  const wordSmCss = extractCssBlock(styleContent, '\\.word\\.sm')
  const wordXsCss = extractCssBlock(styleContent, '\\.word\\.xs')

  // Build word spans
  const words = text.split(/\s+/).filter(Boolean)
  const wordSpans = words.map(w => `<span class="word">${escapeHtml(w)}</span> `).join('')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=${width}, height=${height}">
  ${linkTags}
  <script src="${GSAP_CDN}"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #000; }
    .clip { position: absolute; top: 0; left: 0; visibility: hidden; }
    ${wordCss}
    ${wordSmCss}
    ${wordXsCss}
    #text-overlay {
      position: absolute;
      top: ${Math.round(height * 0.70)}px;
      left: 0;
      width: ${width}px;
      text-align: center;
      padding: 0 36px;
    }
  </style>
</head>
<body>
  <div id="root"
    data-composition-id="${id}"
    data-start="0"
    data-duration="${dur}"
    data-width="${width}"
    data-height="${height}"
    style="position:relative;width:${width}px;height:${height}px;overflow:hidden;">
    <video
      id="video"
      class="clip"
      src="${videoFile}"
      muted
      playsinline
      data-start="0"
      data-duration="${dur}"
      data-track-index="0"
      style="width:${width}px;height:${height}px;object-fit:cover;"
    ></video>
    <div id="overlay" class="clip" data-start="0" data-duration="${dur}" data-track-index="1"
         style="position:absolute;top:0;left:0;width:${width}px;height:${height}px;">
      <div id="text-overlay">${wordSpans}</div>
    </div>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    tl.to('#video', { opacity: 1, duration: 0.01 }, 0);
    const words = document.querySelectorAll('.word');
    tl.fromTo(words, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.4, stagger: 0.09, ease: 'power3.out' }, 0.2);
    window.__timelines['${id}'] = tl;
  </script>
</body>
</html>`
}
