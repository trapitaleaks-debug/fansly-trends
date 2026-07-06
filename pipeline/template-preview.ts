// Render a short demo video for a template (memes AND styles) so the Templates page shows
// exactly what each one produces. Uses a generated neutral demo clip + a demo brand pack —
// no model footage involved. Output → R2 templates/previews/<id>.mp4 + preview_r2_key.

import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { r2, uploadToR2 } from '../lib/r2'
import { supabaseAdmin } from '../lib/supabase'
import { renderWithRemotion } from './remotion-renderer'
import type { TemplateManifest } from './remotion/types'

const BUCKET = process.env.R2_BUCKET_NAME ?? 'fansly-trends'
const ffmpegBin = () => (process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg')

const DEMO_BRAND = {
  font_primary: 'Poppins',
  font_weight: '700',
  color_text: '#FFFFFF',
  color_accent: '#F472B6',
  color_shadow: '#000000',
  effects: ['outline', 'drop-shadow'],
  animation_primary: 'slide-up',
}

async function dl(key: string, dest: string) {
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  const chunks: Uint8Array[] = []
  for await (const c of res.Body as AsyncIterable<Uint8Array>) chunks.push(c)
  fs.writeFileSync(dest, Buffer.concat(chunks))
}

export async function renderTemplatePreview(templateId: string): Promise<string> {
  const { data: tpl, error } = await supabaseAdmin
    .from('video_templates')
    .select('id, name, manifest')
    .eq('id', templateId)
    .single()
  if (error || !tpl?.manifest) throw new Error(`template not found or no manifest: ${error?.message ?? templateId}`)
  const manifest = tpl.manifest as TemplateManifest

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tplprev_'))
  try {
    // Soft animated gradient stands in for model footage
    const clip = path.join(tmp, 'demo.mp4')
    const duration = Math.min(manifest.duration_sec ?? 5, 6)
    execSync(
      `${ffmpegBin()} -y -f lavfi -i "gradients=size=1080x1920:speed=0.02:c0=#2a1030:c1=#0c1b3a:c2=#3a0f22:nb_colors=3" ` +
      `-t ${duration} -r 30 -pix_fmt yuv420p "${clip}"`,
      { stdio: 'pipe', timeout: 120_000 },
    )

    const assetPaths: Record<string, string> = {}
    let n = 0
    const keys = [manifest.slot?.frame_asset, manifest.slot?.fg_asset, ...(manifest.overlays ?? []).map(o => o.src)].filter(Boolean) as string[]
    for (const key of keys) {
      const local = path.join(tmp, `tpl_${n++}${path.extname(key) || '.png'}`)
      await dl(key, local)
      assetPaths[key] = local
    }
    // Sticker slot → a fixed demo sticker so previews show the bounce-in
    let stickerPath: string | undefined
    if ((manifest.overlays ?? []).some(o => o.type === 'sticker')) {
      try {
        stickerPath = path.join(tmp, 'tpl_sticker.png')
        await dl('templates/stickers/heart-eyes.png', stickerPath)
      } catch { stickerPath = undefined }
    }

    const demoText = manifest.fixed_lines?.length
      ? manifest.fixed_lines.join('\n').replace(/\[placeholder\]/gi, 'gym girls')
      : 'this is how your caption looks 💕'
    const captionLines = demoText.split('\n').filter(Boolean).map((text, i, arr) => ({
      text, startSec: (i / Math.max(1, arr.length)) * (manifest.layout === 'meme-slot' ? 0 : duration),
    }))

    const out = path.join(tmp, 'preview.mp4')
    await renderWithRemotion({
      videoPath: clip,
      captionLines,
      brandConfig: DEMO_BRAND as never,
      durationSec: duration,
      clipDurationSec: duration,
      outputPath: out,
      template: { manifest, assetPaths, stickerPath },
    })

    const key = `templates/previews/${templateId}.mp4`
    await uploadToR2(key, fs.readFileSync(out), 'video/mp4')
    await supabaseAdmin.from('video_templates').update({ preview_r2_key: key }).eq('id', templateId)
    return key
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
