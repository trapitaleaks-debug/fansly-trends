import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { uploadToR2 } from '@/lib/r2'

type Params = { params: Promise<{ username: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const { username } = await params

  const { data: model } = await supabaseAdmin
    .from('trends_models')
    .select('id')
    .eq('fansly_username', username.toLowerCase())
    .single()

  if (!model) return NextResponse.json({ error: 'Model not found' }, { status: 404 })

  const formData = await request.formData()
  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })

  const buffer = Buffer.from(await file.arrayBuffer())
  const key = `brand-html/${model.id}.html`

  await uploadToR2(key, buffer, 'text/html')

  const { error } = await supabaseAdmin
    .from('trends_models')
    .update({ brand_html_r2_key: key })
    .eq('id', model.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, key })
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { username } = await params

  const { data: model } = await supabaseAdmin
    .from('trends_models')
    .select('id')
    .eq('fansly_username', username.toLowerCase())
    .single()

  if (!model) return NextResponse.json({ error: 'Model not found' }, { status: 404 })

  const { error } = await supabaseAdmin
    .from('trends_models')
    .update({ brand_html_r2_key: null })
    .eq('id', model.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
