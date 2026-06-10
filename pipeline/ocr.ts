/**
 * Vision OCR for source trending videos.
 *
 * When a suggestion is approved with text_mode='original', the pipeline must copy
 * the EXACT on-screen text that's burned into the source video — not the post
 * caption (which is hashtags), and not text the brief AI invents. The scraper
 * stores a single thumbnail frame per post at thumbs/{fansly_post_id}.jpg; we read
 * the overlay text off that frame with Claude vision.
 */

import Anthropic from '@anthropic-ai/sdk'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { r2 } from '../lib/r2'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const BUCKET = process.env.R2_BUCKET_NAME ?? 'fansly-trends'

async function downloadBytes(key: string): Promise<Buffer | null> {
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    if (!res.Body) return null
    const chunks: Uint8Array[] = []
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk)
    return Buffer.concat(chunks)
  } catch {
    return null
  }
}

function mediaType(key: string): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' {
  const k = key.toLowerCase()
  if (k.endsWith('.png')) return 'image/png'
  if (k.endsWith('.webp')) return 'image/webp'
  if (k.endsWith('.gif')) return 'image/gif'
  return 'image/jpeg'
}

const OCR_PROMPT = `You are a text-transcription tool. This is a single frame from a short-form vertical video. Transcribe ONLY the large text overlay the creator burned onto the video — the caption-style hook text sitting on top of the footage. This is pure OCR: you transcribe the words, you do not describe or comment on the imagery.

IGNORE: watermarks, the creator's @username, platform logos/UI, view counts, timestamps, and any tiny corner text.

Return the overlay text EXACTLY as written — preserve the wording, capitalization, punctuation and any emoji. Do not paraphrase, translate, or fix spelling.

If the frame has no overlay text, OR you are unwilling to transcribe it for any reason, return exactly: NONE

Return only the overlay text, or NONE. Never return a sentence about yourself, the request, or the image. No quotes, no explanation.`

// Vision models return refusals as ordinary text (e.g. "I'm not going to help with
// this request."), not exceptions — those must never become overlay text. Real
// overlays are short, viewer-facing bait; refusals talk about the assistant, the
// "request", or the "image"/"content", and pair a refusal verb with help/assist/etc.
// We require that pairing so legit first-person bait ("I don't usually show this
// side of me", "I'm not going to lie") is NOT false-flagged.
function isRefusal(text: string): boolean {
  const t = text.toLowerCase()
  const signals: RegExp[] = [
    /\bthis request\b/,
    /\b(?:can'?t|cannot|can not|won'?t|will not|unable to|not able to|not going to|not willing to|refuse to)\s+(?:help|assist|engage|describe|provide|generate|create|transcribe|comply|complete|fulfill|do that|do this|with that|with this)\b/,
    /\bi\s*(?:'m|am)\s+(?:sorry|unable|not comfortable|not able)\b/,
    /\bi (?:don'?t|do not) feel comfortable\b/,
    /\bi apologize\b/,
    /\bi won'?t (?:engage|describe|be able)\b/,
    /\bexplicit (?:sexual )?content\b/,
    /\b(?:the|this) image (?:contains|shows|depicts|appears)\b/,
  ]
  if (signals.some(re => re.test(t))) return true
  // Overlay hooks are short; a long paragraph is an explanation/refusal, not overlay text.
  if (text.length > 220) return true
  return false
}

/**
 * Reads the verbatim on-screen overlay text from a source video's thumbnail frame.
 * Returns the text, or '' when there is no overlay / the key is missing / on error.
 * Never throws — callers fall back to the AI-generated overlay text.
 */
export async function extractOnScreenText(thumbnailR2Key: string | null | undefined): Promise<string> {
  if (!thumbnailR2Key) return ''
  const bytes = await downloadBytes(thumbnailR2Key)
  if (!bytes || bytes.length === 0) {
    console.log(`  [ocr] thumbnail not in R2 (${thumbnailR2Key}) — falling back to AI overlay`)
    return ''
  }

  try {
    const res = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType(thumbnailR2Key), data: bytes.toString('base64') },
          },
          { type: 'text', text: OCR_PROMPT },
        ],
      }],
    })
    const out = (res.content.find(c => c.type === 'text') as { text: string } | undefined)?.text?.trim() ?? ''
    if (!out || out.toUpperCase() === 'NONE') return ''
    if (isRefusal(out)) {
      console.log(`  [ocr] Claude refused / non-text response ("${out.slice(0, 60)}") — falling back to AI overlay`)
      return ''
    }

    return out
  } catch (e) {
    console.log(`  [ocr] vision OCR failed: ${(e as Error).message}`)
    return ''
  }
}
