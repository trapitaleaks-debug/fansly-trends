// Deterministic caption → sticker selection from the shared pack (NO LLM — user decision).
// The pack manifest lives in R2 at templates/stickers/manifest.json:
//   { "stickers": [{ "key": "templates/stickers/flirty.png", "mood": "flirty", "keywords": ["kiss","tease",...] }, ...] }
// First keyword match wins; no match → stable jobId-hash pick so the same job always
// renders the same sticker.

import { GetObjectCommand } from '@aws-sdk/client-s3'
import { r2 } from './r2'

const BUCKET = process.env.R2_BUCKET_NAME ?? 'fansly-trends'
const MANIFEST_KEY = 'templates/stickers/manifest.json'

type StickerEntry = { key: string; mood: string; keywords: string[] }

let cache: { entries: StickerEntry[]; loadedAt: number } | null = null

async function loadManifest(): Promise<StickerEntry[]> {
  if (cache && Date.now() - cache.loadedAt < 10 * 60_000) return cache.entries
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: MANIFEST_KEY }))
  const chunks: Uint8Array[] = []
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk)
  const parsed = JSON.parse(Buffer.concat(chunks).toString()) as { stickers: StickerEntry[] }
  cache = { entries: parsed.stickers ?? [], loadedAt: Date.now() }
  return cache.entries
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

export async function pickStickerKey(captionText: string, jobId: string): Promise<string | null> {
  const entries = await loadManifest()
  if (entries.length === 0) return null
  const text = captionText.toLowerCase()
  for (const entry of entries) {
    if (entry.keywords.some(k => text.includes(k.toLowerCase()))) return entry.key
  }
  return entries[hashString(jobId) % entries.length].key
}
