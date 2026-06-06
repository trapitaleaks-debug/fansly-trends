import fs from 'fs'

const API_BASE = 'https://api.kie.ai/api/v1'
const UPLOAD_BASE = 'https://kieai.redpandaai.co'

interface KieResponse<T> {
  code: number
  msg: string
  data: T
}

function headers() {
  const key = process.env.KIE_API_KEY
  if (!key) throw new Error('KIE_API_KEY not set')
  return { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }
}

export async function uploadFileToKie(localPath: string, fileName: string, folder = 'pipeline'): Promise<string> {
  const buffer = fs.readFileSync(localPath)
  const ext = localPath.split('.').pop()?.toLowerCase() ?? 'jpg'
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg'
  const base64Data = `data:${mime};base64,${buffer.toString('base64')}`

  const res = await fetch(`${UPLOAD_BASE}/api/file-base64-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.KIE_API_KEY}` },
    body: JSON.stringify({ base64Data, uploadPath: folder, fileName }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`KIE upload failed ${res.status}: ${text}`)
  const json: KieResponse<{ downloadUrl: string }> = JSON.parse(text)
  if (json.code !== 200) throw new Error(`KIE upload error (${json.code}): ${json.msg}`)
  return json.data.downloadUrl
}

export async function createImageTask(prompt: string, imageUrls: string[], nsfw = true): Promise<string> {
  const body = {
    model: 'seedream/4.5-edit',
    input: {
      prompt,
      aspect_ratio: '9:16',
      quality: 'basic',
      nsfw_checker: false,
      image_urls: imageUrls,
    },
  }
  const res = await fetch(`${API_BASE}/jobs/createTask`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`KIE createTask failed ${res.status}: ${text}`)
  const json: KieResponse<{ taskId: string }> = JSON.parse(text)
  if (json.code !== 200) throw new Error(`KIE createTask error (${json.code}): ${json.msg}`)
  return json.data.taskId
}

export async function createVideoTask(prompt: string, firstFrameUrl: string): Promise<string> {
  const body = {
    model: 'wan/2-7-image-to-video',
    input: {
      prompt,
      first_frame_url: firstFrameUrl,
      resolution: '720p',
      duration: 7,
      prompt_extend: true,
      watermark: false,
      nsfw_checker: false,
    },
  }
  const res = await fetch(`${API_BASE}/jobs/createTask`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`KIE video createTask failed ${res.status}: ${text}`)
  const json: KieResponse<{ taskId: string }> = JSON.parse(text)
  if (json.code !== 200) throw new Error(`KIE video createTask error (${json.code}): ${json.msg}`)
  return json.data.taskId
}

export async function pollTask(taskId: string, timeoutMs = 15 * 60 * 1000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(5000)
    const res = await fetch(`${API_BASE}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: headers(),
    })
    const text = await res.text()
    if (!res.ok) { console.error(`[poll ${taskId}] HTTP ${res.status}`); continue }

    const json: KieResponse<{ state?: string; resultJson?: string; failMsg?: string }> = JSON.parse(text)
    if (json.code !== 200) continue

    const state = json.data?.state
    if (state === 'success') {
      const result = JSON.parse(json.data.resultJson ?? '{}')
      const url = (result.resultUrls ?? result.result_urls ?? [])[0]
      if (!url) throw new Error(`Task ${taskId} succeeded but no URL in resultJson`)
      return url
    }
    if (state === 'fail') {
      throw new Error(`Task ${taskId} failed: ${json.data.failMsg ?? 'unknown'}`)
    }
    // still processing/queuing
  }
  throw new Error(`Task ${taskId} timed out after ${timeoutMs / 1000}s`)
}

export function sleep(ms: number) {
  return new Promise(res => setTimeout(res, ms))
}
