/**
 * Video quality scoring — 8 SOP dimensions + AI Generation Quality.
 * Auto-disqualifies videos where AI artifacts are clearly visible.
 */

import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import type { VideoScores } from './db'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SCORE_PROMPT = (overlayText: string, format: string) => `Score this short-form video thumbnail across 9 quality dimensions for social media.

Overlay text: "${overlayText}" | Format: ${format}

Score each 0–10, no decimals:

1. hook_power — Does the first frame visually stop a fast scroll? (motion, bold colors, pattern interrupt, face expression)
2. replayability — Does the framing reward a second watch? Hidden detail, seamless loop potential?
3. retention — Does the visual suggest something worth watching all the way to the end?
4. payoff — Does the final frame appear to deliver a payoff/reveal?
5. video_quality — Technical quality: lighting, sharpness, resolution, exposure
6. content_calibration — Is the content intensity well-calibrated? (0 = too tame to notice, 10 = perfectly calibrated for platform, don't penalize sensual/suggestive content)
7. text_captions — Does the overlay text placement and readability look good?
8. background_props — Is the background/setting visually interesting, or plain and generic?
9. ai_quality — CRITICAL. How photorealistic is this? Inspect closely: unnatural teeth shape/color, distorted lips or mouth, deformed hands or arms, plastic-looking skin, uncanny eyes, AI texture artifacts on hair. 0 = obviously AI, no question. 5 = some artifacts but passable. 10 = indistinguishable from a real photo.

Return ONLY a JSON object, no other text:
{"hook_power":7,"replayability":6,"retention":7,"payoff":5,"video_quality":8,"content_calibration":7,"text_captions":8,"background_props":6,"ai_quality":4,"notes":"Hands look unnatural, teeth too uniform"}`

export async function scoreVideo(thumbPath: string, overlayText: string, contentFormat: string): Promise<VideoScores> {
  const fallback: VideoScores = {
    hook_power: 5, replayability: 5, retention: 5, payoff: 5,
    video_quality: 5, content_calibration: 5, text_captions: 5,
    background_props: 5, ai_quality: 6,
    total: 45, disqualified: false, notes: 'Scoring unavailable',
  }

  try {
    const buffer = fs.readFileSync(thumbPath)
    const data = buffer.toString('base64')

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
          { type: 'text', text: SCORE_PROMPT(overlayText, contentFormat) },
        ],
      }],
    })

    const text = (response.content[0] as { type: string; text: string }).text
    const jsonMatch = text.match(/\{[\s\S]*\}/m)
    if (!jsonMatch) return fallback

    const raw = JSON.parse(jsonMatch[0])
    const dims = ['hook_power', 'replayability', 'retention', 'payoff', 'video_quality',
      'content_calibration', 'text_captions', 'background_props', 'ai_quality']
    const total = dims.reduce((sum, k) => sum + (Number(raw[k]) || 5), 0)

    return {
      hook_power: raw.hook_power ?? 5,
      replayability: raw.replayability ?? 5,
      retention: raw.retention ?? 5,
      payoff: raw.payoff ?? 5,
      video_quality: raw.video_quality ?? 5,
      content_calibration: raw.content_calibration ?? 5,
      text_captions: raw.text_captions ?? 5,
      background_props: raw.background_props ?? 5,
      ai_quality: raw.ai_quality ?? 5,
      total,
      disqualified: (raw.ai_quality ?? 6) < 5,
      notes: raw.notes ?? '',
    }
  } catch (e) {
    console.error('  ⚠ Video scoring failed:', (e as Error).message)
    return fallback
  }
}
