import * as dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(__dirname, '../.env.local') })
import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import { renderWithRemotion } from './remotion-renderer'

async function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary_'))
  const clip = path.join(tmp, 'test.mp4')
  execSync(`/opt/homebrew/bin/ffmpeg -y -f lavfi -i testsrc2=size=1080x1920:rate=30 -t 5 -pix_fmt yuv420p "${clip}"`, { stdio: 'pipe' })

  const cases = [
    {
      name: 'goth-gradient',
      brand: { font_primary: 'Cinzel Decorative', font_fallback: 'Cormorant Garamond', font_weight: '700', font_style: 'normal', color_text: '#F5F0F2', color_accent: '#8B0A1A', color_shadow: '#0A0708', effects: ['glow', 'drop-shadow', 'gradient-fill'] },
      lines: [{ text: 'shut your mouth', startSec: 0 }, { text: 'with my 🖤', startSec: 2.4 }],
    },
    {
      name: 'blackletter-400only',
      brand: { font_primary: 'Pirata One', font_weight: '400', color_text: '#ffffff', color_accent: '#f472b6', color_shadow: '#000000', effects: ['glow', 'outline'] },
      lines: [{ text: 'when I show ur my gallery', startSec: 0 }],
    },
  ]
  const memeCase = {
    name: 'meme-list',
    brand: { color_text: '#111111', color_shadow: '#00000000' },
    lines: [{ text: 'Basic Human Needs', startSec: 0 }, { text: '1. Water', startSec: 0.1 }, { text: '2. Oxygen', startSec: 0.2 }, { text: '3.', startSec: 0.3 }],
    template: {
      manifest: {
        layout: 'meme-slot', duration_sec: 5,
        slot: { x: 16, y: 42, w: 40, h: 36, shape: 'rect', bg_color: '#f5f5f2' },
        text: { zone: 'top', align: 'left', font_role: 'display', font_family: 'Archivo Black', font_weights: [400], size: 58, effects: [], color_text: '#111111' },
      },
      assetPaths: {},
    },
  }
  ;(cases as unknown[]).push(memeCase)
  for (const c of cases) {
    const out = path.join(tmp, `${c.name}.mp4`)
    const t0 = Date.now()
    await renderWithRemotion({ videoPath: clip, captionLines: c.lines, brandConfig: c.brand as never, durationSec: 5, clipDurationSec: 5, outputPath: out, template: (c as { template?: never }).template })
    const secs = Math.round((Date.now() - t0) / 1000)
    const frame = `/private/tmp/claude-501/-Users-leonardoguizzo-Documents-Obsidian/b49d7ea1-90d6-4ce1-b3d7-18184401ce78/scratchpad/canary-${c.name}.png`
    execSync(`/opt/homebrew/bin/ffmpeg -y -ss 3 -i "${out}" -vframes 1 "${frame}"`, { stdio: 'pipe' })
    console.log(`${c.name}: rendered in ${secs}s → ${frame}`)
  }
}
run().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
