// Apple iOS emoji rendering (user requirement: real iPhone-look emojis, not Noto).
// Apple's emoji FONT is proprietary and can't run on the Linux render server — instead we
// inline the Apple emoji ARTWORK (emoji-datasource-apple, the Slack-style image set) as
// data-URI <img> elements sized to the text. process-job extracts the emojis present in a
// caption and ships only those images to the composition via inputProps.

import fs from 'fs'
import path from 'path'

type EmojiEntry = { unified: string; non_qualified: string | null; image: string; has_img_apple: boolean }

let nativeToFile: Map<string, string> | null = null

function unifiedToNative(unified: string): string {
  return String.fromCodePoint(...unified.split('-').map(u => parseInt(u, 16)))
}

function loadMap(): Map<string, string> {
  if (nativeToFile) return nativeToFile
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const data = require('emoji-datasource-apple/emoji.json') as EmojiEntry[]
  nativeToFile = new Map()
  for (const e of data) {
    if (!e.has_img_apple) continue
    nativeToFile.set(unifiedToNative(e.unified), e.image)
    // Also map the non-qualified form (without FE0F variation selectors) — keyboards emit both.
    if (e.non_qualified) nativeToFile.set(unifiedToNative(e.non_qualified), e.image)
  }
  return nativeToFile
}

// Split text into emoji / non-emoji segments. Longest-match first handles ZWJ sequences
// (e.g. 👩‍❤️‍👨) before their component emojis.
export function splitEmoji(text: string): Array<{ text: string; isEmoji: boolean }> {
  const map = loadMap()
  const segments: Array<{ text: string; isEmoji: boolean }> = []
  const chars = Array.from(text)
  let buf = ''
  let i = 0
  while (i < chars.length) {
    // try longest emoji match up to 8 codepoints (covers ZWJ families + skin tones)
    let matched: string | null = null
    for (let len = Math.min(8, chars.length - i); len >= 1; len--) {
      const cand = chars.slice(i, i + len).join('')
      if (map.has(cand)) { matched = cand; break }
    }
    if (matched) {
      if (buf) { segments.push({ text: buf, isEmoji: false }); buf = '' }
      segments.push({ text: matched, isEmoji: true })
      i += Array.from(matched).length
    } else {
      buf += chars[i]
      i++
    }
  }
  if (buf) segments.push({ text: buf, isEmoji: false })
  return segments
}

// Data URIs for every Apple emoji appearing in `text` (64px PNGs, ~2-6KB each).
export function appleEmojiDataUris(text: string): Record<string, string> {
  const map = loadMap()
  const out: Record<string, string> = {}
  for (const seg of splitEmoji(text)) {
    if (!seg.isEmoji || out[seg.text]) continue
    const file = map.get(seg.text)
    if (!file) continue
    try {
      const p = path.join(path.dirname(require.resolve('emoji-datasource-apple/emoji.json')), 'img', 'apple', '64', file)
      out[seg.text] = `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`
    } catch { /* missing image — falls back to font rendering */ }
  }
  return out
}
