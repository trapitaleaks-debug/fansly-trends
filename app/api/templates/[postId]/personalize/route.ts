import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

type Params = { params: Promise<{ postId: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const { postId } = await params
  const { model_username } = await request.json()
  if (!model_username) return NextResponse.json({ error: 'model_username required' }, { status: 400 })

  const [{ data: post }, { data: model }] = await Promise.all([
    supabaseAdmin.from('trends_posts').select('text_template').eq('id', postId).single(),
    supabaseAdmin.from('trends_models').select('fansly_username, branding_file_md, video_brand_config').eq('fansly_username', model_username).single(),
  ])

  if (!post?.text_template) return NextResponse.json({ error: 'Template not found' }, { status: 404 })
  if (!model) return NextResponse.json({ error: 'Model not found' }, { status: 404 })

  const brandContext = model.video_brand_config
    ? `Video brand config:\n${JSON.stringify(model.video_brand_config, null, 2)}`
    : model.branding_file_md
    ? `Personal branding file (excerpt):\n${model.branding_file_md.slice(0, 3000)}`
    : `Model: @${model.fansly_username}`

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `You adapt video text overlays for OnlyFans/Fansly creators. Keep the same structure and emotional tone. Only change specific details (age, ethnicity, nationality, personality traits) to match the model's identity. Never change the format — one line per overlay, same number of lines. Never add emojis. Never explain — just output the adapted text.

TEMPLATE:
${post.text_template}

MODEL PROFILE:
${brandContext}

Output only the adapted text, same number of lines, nothing else.`,
      },
    ],
  })

  const personalized = (message.content[0] as { type: string; text: string }).text.trim()
  return NextResponse.json({ personalized_text: personalized, original: post.text_template })
}
