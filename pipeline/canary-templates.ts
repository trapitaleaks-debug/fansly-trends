import * as dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(__dirname, '../.env.local') })
import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { r2 } from '../lib/r2'
import { renderWithRemotion } from './remotion-renderer'
import { supabaseAdmin } from '../lib/supabase'
import type { TemplateManifest } from './remotion/types'

const BUCKET = process.env.R2_BUCKET_NAME ?? 'fansly-trends'
const SP = '/private/tmp/claude-501/-Users-leonardoguizzo-Documents-Obsidian/b49d7ea1-90d6-4ce1-b3d7-18184401ce78/scratchpad'

async function dl(key: string, dest: string) {
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  const chunks: Uint8Array[] = []
  for await (const c of res.Body as AsyncIterable<Uint8Array>) chunks.push(c)
  fs.writeFileSync(dest, Buffer.concat(chunks))
}

async function run() {
  const names = ['Dangerous Trap', "What's On Your Mind", 'CJ Here We Go Again', 'Cortisol Meter']
  const { data: templates } = await supabaseAdmin.from('video_templates').select('name, manifest').in('name', names)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tplcanary_'))
  const clip = path.join(tmp, 'clip.mp4')
  execSync(`/opt/homebrew/bin/ffmpeg -y -f lavfi -i testsrc2=size=1080x1920:rate=30 -t 6 -pix_fmt yuv420p "${clip}"`, { stdio: 'pipe' })

  for (const t of (templates ?? []) as Array<{ name: string; manifest: TemplateManifest }>) {
    const m = t.manifest
    const assetPaths: Record<string, string> = {}
    let n = 0
    const keys = [m.slot?.frame_asset, m.slot?.fg_asset, ...(m.overlays ?? []).map(o => o.src)].filter(Boolean) as string[]
    for (const key of keys) {
      const local = path.join(tmp, `tpl_${n++}${path.extname(key)}`)
      await dl(key, local)
      assetPaths[key] = local
    }
    const captionLines = (m.fixed_lines ?? []).join('\n').split('\n').filter(Boolean).map((text, i) => ({ text: text.replace(/\[placeholder\]/gi, 'leg day'), startSec: 0 }))
    const slug = t.name.toLowerCase().replace(/[^a-z]+/g, '-')
    const out = path.join(tmp, `${slug}.mp4`)
    const t0 = Date.now()
    await renderWithRemotion({
      videoPath: clip,
      captionLines,
      brandConfig: { color_text: '#ffffff', color_accent: '#FF2D78', color_shadow: '#000000', font_primary: 'Bebas Neue' } as never,
      durationSec: m.duration_sec ?? 6,
      clipDurationSec: 6,
      outputPath: out,
      template: { manifest: m, assetPaths },
    })
    const secs = Math.round((Date.now() - t0) / 1000)
    execSync(`/opt/homebrew/bin/ffmpeg -y -ss 3 -i "${out}" -vframes 1 "${SP}/tpl-${slug}.png"`, { stdio: 'pipe' })
    console.log(`${t.name}: ${secs}s → tpl-${slug}.png`)
  }
}
run().catch(e => { console.error('Fatal:', e.message.slice(0, 300)); process.exit(1) })
