import { renderMedia, selectComposition } from '@remotion/renderer'
import { bundle } from '@remotion/bundler'
import path from 'path'
import os from 'os'
import type { CaptionLine, VideoBrandConfig } from './remotion/types'

export type { CaptionLine, VideoBrandConfig }

export interface RemotionRenderOptions {
  videoPath: string
  audioPath?: string
  captionLines: CaptionLine[]
  brandConfig: VideoBrandConfig | null
  durationSec: number
  outputPath: string
}

let _bundleLocation: string | null = null
let _bundling: Promise<string> | null = null

async function getBundleLocation(): Promise<string> {
  if (_bundleLocation) return _bundleLocation
  if (_bundling) return _bundling

  console.log('[remotion] Bundling composition (first call — this takes ~60s)...')
  _bundling = bundle({
    entryPoint: path.join(__dirname, 'remotion/index.ts'),
    outDir: path.join(os.tmpdir(), 'remotion-bundle'),
  }).then(loc => {
    _bundleLocation = loc
    _bundling = null
    console.log('[remotion] Bundle ready at', loc)
    return loc
  })

  return _bundling
}

export async function renderWithRemotion(opts: RemotionRenderOptions): Promise<void> {
  const serveUrl = await getBundleLocation()

  const inputProps = {
    videoSrc: `file://${opts.videoPath}`,
    audioSrc: opts.audioPath ? `file://${opts.audioPath}` : undefined,
    captionLines: opts.captionLines,
    brandConfig: opts.brandConfig,
    durationSec: opts.durationSec,
  }

  const composition = await selectComposition({
    serveUrl,
    id: 'VideoOverlay',
    inputProps,
    browserExecutable: process.env.HYPERFRAMES_BROWSER_PATH ?? null,
    chromiumOptions: { disableWebSecurity: true },
  })

  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: opts.outputPath,
    inputProps,
    browserExecutable: process.env.HYPERFRAMES_BROWSER_PATH ?? null,
    chromiumOptions: { disableWebSecurity: true },
    crf: 20,
    timeoutInMilliseconds: 5 * 60 * 1000,
  })
}
