import * as dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(__dirname, '../.env.local') })
import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import { renderWithRemotion } from './remotion-renderer'
import { appleEmojiDataUris } from '../lib/apple-emoji'

async function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emoji_'))
  const clip = path.join(tmp, 'test.mp4')
  execSync(`/opt/homebrew/bin/ffmpeg -y -f lavfi -i testsrc2=size=1080x1920:rate=30 -t 5 -pix_fmt yuv420p "${clip}"`, { stdio: 'pipe' })
  const text = 'is my pussy your type 🥺 be honest 😏🔥 and this line is intentionally very long to verify the new side margins wrap it properly'
  const emojiImages = appleEmojiDataUris(text)
  console.log('emoji map:', Object.keys(emojiImages).join(' '), `(${Object.keys(emojiImages).length})`)
  const out = path.join(tmp, 'out.mp4')
  await renderWithRemotion({
    videoPath: clip,
    captionLines: [{ text, startSec: 0 }],
    brandConfig: { font_primary: 'Playfair Display', font_weight: '700', font_style: 'italic', color_text: '#FFFFFF', color_accent: '#D4001A', color_shadow: '#0A0000', effects: ['glow', 'drop-shadow'], animation_primary: 'slide-up' } as never,
    durationSec: 5,
    clipDurationSec: 5,
    outputPath: out,
    emojiImages,
  })
  execSync(`/opt/homebrew/bin/ffmpeg -y -ss 4 -i "${out}" -vframes 1 "/private/tmp/claude-501/-Users-leonardoguizzo-Documents-Obsidian/b49d7ea1-90d6-4ce1-b3d7-18184401ce78/scratchpad/canary-emoji.png"`, { stdio: 'pipe' })
  console.log('rendered')
}
run().catch(e => { console.error('Fatal:', e.message.slice(0, 300)); process.exit(1) })
