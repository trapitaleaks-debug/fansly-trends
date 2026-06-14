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

export interface BrandConfig {
  font_primary: string
  font_weight?: string
  font_style?: string
  font_fallback?: string
  font_size_px?: number
  color_text: string
  color_accent?: string
  color_shadow?: string
  effects?: string[]
  animation_primary?: string
  animation_ease?: string
  animation_duration_ms?: number
  animation_secondary?: string
  stickers?: string[]
}

type LineSize = 'lg' | 'sm' | 'xs'

function stripEmojiFromText(text: string): string {
  return text
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitIntoHookLines(text: string): Array<{ text: string; size: LineSize }> {
  // Split on explicit newlines first
  const byNewline = text.split(/\n/).map(p => p.trim()).filter(Boolean)
  if (byNewline.length >= 2) {
    if (byNewline.length === 2) return [{ text: byNewline[0], size: 'sm' }, { text: byNewline[1], size: 'lg' }]
    return byNewline.map((p, i) => ({ text: p, size: (i === 0 || i === byNewline.length - 1 ? 'sm' : 'lg') as LineSize }))
  }
  // Try splitting at a natural punctuation boundary
  const p = text.trim()
  const m = p.match(/^(.+?[.!?,…])\s+(.+)$/)
  if (m && m[1].length > 4 && m[2].length > 3) {
    return [{ text: m[1], size: 'sm' }, { text: m[2], size: 'lg' }]
  }
  return [{ text: p, size: 'lg' }]
}

/**
 * Builds a Hyperframes composition from a brand config JSON.
 * Uses the same DOM-building technique as the brand preview HTML (span.textContent = w + ' ')
 * to guarantee word spacing. Strips emoji from text; first sticker from config is the emoji.
 */
export function buildCompositionFromBrandConfig(
  config: BrandConfig,
  videoFile: string,
  overlayText: string,
  duration: number,
  slot: number,
  width = 720,
  height = 1280
): string {
  const id = `slot${slot}`
  const dur = duration.toFixed(2)

  // Strip emoji — rendered as ugly Noto glyphs in Linux Chrome; sticker handles it separately
  const text = stripEmojiFromText(overlayText.trim())

  const fontFamily = `'${config.font_primary}', '${config.font_fallback ?? 'Georgia'}', serif`
  const fontWeight = config.font_weight ?? '700'
  const fontStyle = config.font_style ?? 'normal'
  // Use config value or scale up for video canvas (brand preview was 50px on 320px phone frame)
  const sizeLg = config.font_size_px ?? 90
  const sizeSm = Math.round(sizeLg * 0.68)
  const sizeXs = Math.round(sizeLg * 0.52)
  const colorText = config.color_text
  const colorAccent = config.color_accent ?? '#FFFFFF'
  const colorShadow = config.color_shadow ?? '#0A0A0A'
  const effects = config.effects ?? []
  const sticker = (config.stickers ?? [])[0] ?? null

  // Text effects — match brand preview exactly
  const shadows: string[] = []
  if (effects.includes('drop-shadow')) shadows.push(`3px 3px 0px ${colorShadow}`)
  if (effects.includes('glow')) {
    const r = parseInt(colorText.slice(1, 3), 16)
    const g = parseInt(colorText.slice(3, 5), 16)
    const b = parseInt(colorText.slice(5, 7), 16)
    shadows.push(`0 0 20px rgba(${r},${g},${b},0.9)`)
    shadows.push(`0 0 50px rgba(${r},${g},${b},0.4)`)
  }
  const textShadow = shadows.length > 0 ? shadows.join(', ') : 'none'
  const strokeWidth = effects.includes('outline') ? '1.6px' : '0px'

  const localFontFile = `${config.font_primary.toLowerCase().replace(/ /g, '-')}-${fontStyle === 'italic' ? 'italic-' : ''}${fontWeight}.woff2`

  // Lines for the HOOK — JSON injected into the page script
  const lines = splitIntoHookLines(text)
  const hookJson = JSON.stringify({
    lines,
    sticker: sticker ? { emoji: sticker, bottom: '-12px', right: '10px', animation: 'rock' } : null,
  })

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=${width}, height=${height}">
  <script src="${GSAP_CDN}"></script>
  <style>
    @font-face {
      font-family: '${config.font_primary}';
      font-style: ${fontStyle};
      font-weight: ${fontWeight};
      src: url('${localFontFile}') format('woff2');
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #000; }
    .clip { position: absolute; top: 0; left: 0; visibility: hidden; }
    .vignette {
      position: absolute;
      inset: 0;
      background: radial-gradient(ellipse at center, transparent 35%, rgba(0,0,0,0.75) 100%);
      pointer-events: none;
    }
    .composition {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 86%;
      text-align: center;
    }
    .hook-line { display: block; position: relative; }
    .word {
      display: inline-block;
      font-family: ${fontFamily};
      font-weight: ${fontWeight};
      font-style: ${fontStyle};
      font-size: ${sizeLg}px;
      line-height: 1.05;
      color: ${colorText};
      -webkit-text-stroke: ${strokeWidth} ${colorAccent};
      text-shadow: ${textShadow};
      opacity: 0;
      transform: translateY(20px);
    }
    .word.sm { font-size: ${sizeSm}px; }
    .word.xs {
      font-size: ${sizeXs}px;
      font-weight: 400;
      color: rgba(255,255,255,0.8);
      -webkit-text-stroke: 0px;
      text-shadow: 1px 1px 0 #000;
    }
    .sticker {
      position: absolute;
      font-size: ${Math.round(sizeLg * 0.96)}px;
      opacity: 0;
      filter: drop-shadow(0 3px 8px rgba(0,0,0,0.7));
      line-height: 1;
      pointer-events: none;
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
    <div class="vignette clip" data-start="0" data-duration="${dur}" data-track-index="1"
         style="width:${width}px;height:${height}px;"></div>
    <div id="overlay" class="clip" data-start="0" data-duration="${dur}" data-track-index="2"
         style="position:absolute;top:0;left:0;width:${width}px;height:${height}px;">
      <div class="composition" id="composition"></div>
    </div>
  </div>
  <script>
    // Mirrors buildHook() from the brand preview HTML exactly — uses textContent not innerHTML
    // so word spacing is guaranteed regardless of CSS whitespace handling
    var HOOK = ${hookJson};

    function buildHook(hook) {
      var comp = document.getElementById('composition');
      comp.innerHTML = '';
      var allWords = [];

      if (hook.sticker) {
        var stickerEl = document.createElement('span');
        stickerEl.className = 'sticker';
        stickerEl.id = 'sticker';
        stickerEl.textContent = hook.sticker.emoji;
        if (hook.sticker.top)    stickerEl.style.top    = hook.sticker.top;
        if (hook.sticker.bottom) stickerEl.style.bottom = hook.sticker.bottom;
        if (hook.sticker.left)   stickerEl.style.left   = hook.sticker.left;
        if (hook.sticker.right)  stickerEl.style.right  = hook.sticker.right;
        comp.appendChild(stickerEl);
      }

      hook.lines.forEach(function(line) {
        var lineEl = document.createElement('div');
        lineEl.className = 'hook-line';
        line.text.split(' ').forEach(function(w) {
          if (!w) return;
          var span = document.createElement('span');
          var cls = line.size === 'lg' ? 'word' : line.size === 'sm' ? 'word sm' : 'word xs';
          span.className = cls;
          span.textContent = w + ' ';
          lineEl.appendChild(span);
          allWords.push(span);
        });
        comp.appendChild(lineEl);
      });

      return allWords;
    }

    window.__timelines = window.__timelines || {};
    var words = buildHook(HOOK);
    var stickerEl = document.getElementById('sticker');

    var tl = gsap.timeline({ paused: true });
    tl.to('#video', { opacity: 1, duration: 0.01 }, 0);

    gsap.set(words, { opacity: 0, y: 20 });
    tl.to(words, { opacity: 1, y: 0, duration: 0.4, stagger: 0.09, ease: 'power3.out' }, 0.15);

    if (stickerEl) {
      var wordDelay = 0.15 + words.length * 0.09 + 0.05;
      gsap.set(stickerEl, { opacity: 0, scale: 0.2 });
      tl.to(stickerEl, { opacity: 1, scale: 1, duration: 0.55, ease: 'back.out(2)' }, wordDelay);
    }

    window.__timelines['${id}'] = tl;
  </script>
</body>
</html>`
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
