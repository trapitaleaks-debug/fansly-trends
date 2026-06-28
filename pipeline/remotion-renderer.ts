import { renderMedia, selectComposition } from '@remotion/renderer'
import { bundle } from '@remotion/bundler'
import http from 'http'
import net from 'net'
import fs from 'fs'
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

// Whole-render wall-clock cap. Good renders of these short clips finish in well under ~90s, so a
// render past 4min is certainly hung (some clips stall Remotion's <video> load indefinitely). Kept
// tight so a hung clip frees its worker-pool slot fast instead of starving throughput. The pool's
// hard-timeout backstop (6min) and the watchdog (8min) sit ABOVE this.
const RENDER_WALL_CLOCK_MS = 4 * 60 * 1000

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

// chrome-headless-shell cannot load file:// URIs for <video>/<audio> elements.
// Serve the tmpDir over a local HTTP server so Chrome uses http://localhost instead.
function findFreePort(): Promise<number> {
  return new Promise(resolve => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function serveDirectory(dir: string, port: number): http.Server {
  const MIME: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4',
    '.webm': 'video/webm',
  }
  const server = http.createServer((req, res) => {
    const filePath = path.join(dir, decodeURIComponent(req.url ?? '').replace(/^\//, ''))
    if (!fs.existsSync(filePath)) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    const mime = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    const total = fs.statSync(filePath).size
    const rangeHeader = req.headers['range']
    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d+)-(\d*)/)
      if (m) {
        const start = parseInt(m[1], 10)
        const end = m[2] ? parseInt(m[2], 10) : total - 1
        res.writeHead(206, {
          'Content-Type': mime,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        })
        fs.createReadStream(filePath, { start, end }).pipe(res)
        return
      }
    }
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': total, 'Accept-Ranges': 'bytes' })
    fs.createReadStream(filePath).pipe(res)
  })
  server.listen(port, '127.0.0.1')
  return server
}

export async function renderWithRemotion(opts: RemotionRenderOptions): Promise<void> {
  const serveUrl = await getBundleLocation()

  const tmpDir = path.dirname(opts.videoPath)
  const port = await findFreePort()
  const fileServer = serveDirectory(tmpDir, port)
  const toHttp = (p: string) => `http://127.0.0.1:${port}/${path.basename(p)}`

  const inputProps = {
    videoSrc: toHttp(opts.videoPath),
    audioSrc: opts.audioPath ? toHttp(opts.audioPath) : undefined,
    captionLines: opts.captionLines,
    brandConfig: opts.brandConfig,
    durationSec: opts.durationSec,
  }

  console.log(`[remotion] Serving media via http://127.0.0.1:${port}`)

  // Hard wall-clock cap on the whole render. Remotion's `timeoutInMilliseconds` is a
  // per-frame delayRender timeout, and selectComposition has no timeout at all — so a hung
  // Chrome (composition select, font load, a single stuck frame) would dangle forever. That
  // jams the single-flight render cron (its `jobsRunning` guard never clears). This race
  // REJECTS, so processVideoJob's catch fires → the job becomes retryable instead of stuck.
  let wallTimer: NodeJS.Timeout | undefined
  try {
    const renderWork = (async () => {
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
        // Bound Chromium tabs per render so 2 parallel renders can't fan out workers
        // and blow the container process limit.
        concurrency: 2,
        timeoutInMilliseconds: 5 * 60 * 1000,
      })
    })()

    // If the wall-clock wins the race, renderWork keeps running and its later rejection would be
    // an UNHANDLED rejection (Remotion's ffmpeg/Chrome pipe errors surface async). Attach a no-op
    // catch so the loser's eventual rejection is always handled — the race still sees the first
    // settle for control flow.
    renderWork.catch(() => {})

    const wallClock = new Promise<never>((_, reject) => {
      wallTimer = setTimeout(
        () => reject(new Error('renderWithRemotion wall-clock timeout after 4min — render hung')),
        RENDER_WALL_CLOCK_MS
      )
    })

    await Promise.race([renderWork, wallClock])
  } finally {
    if (wallTimer) clearTimeout(wallTimer)
    fileServer.close()
  }
}
