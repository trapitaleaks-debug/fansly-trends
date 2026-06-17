import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

type Params = { params: Promise<{ username: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const { username } = await params

  const { data: model } = await supabaseAdmin
    .from('trends_models')
    .select('id')
    .ilike('fansly_username', username)
    .single()

  if (!model) return NextResponse.json({ error: 'Model not found' }, { status: 404 })

  const formData = await request.formData()
  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })

  const text = await file.text()

  let config: Record<string, unknown>
  if (file.name.endsWith('.json')) {
    config = JSON.parse(text)
  } else {
    // .md file — extract the JSON from the ```json code block
    const match = text.match(/```json\s*\n([\s\S]*?)\n```/)
    if (!match) return NextResponse.json({ error: 'No JSON config block found in markdown file. Add a ```json block with the brand config.' }, { status: 400 })
    config = JSON.parse(match[1])
  }

  const { error } = await supabaseAdmin
    .from('trends_models')
    .update({ video_brand_config: config })
    .eq('id', model.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, config })
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { username } = await params

  const { data: model } = await supabaseAdmin
    .from('trends_models')
    .select('id')
    .ilike('fansly_username', username)
    .single()

  if (!model) return NextResponse.json({ error: 'Model not found' }, { status: 404 })

  const { error } = await supabaseAdmin
    .from('trends_models')
    .update({ video_brand_config: null })
    .eq('id', model.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
