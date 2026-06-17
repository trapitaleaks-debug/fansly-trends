import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { suggestHashtags } from '@/lib/suggestions'

type Params = { params: Promise<{ username: string }> }

export async function POST(_request: NextRequest, { params }: Params) {
  const { username } = await params

  const { data: model } = await supabaseAdmin
    .from('trends_models')
    .select('branding_file_md, hashtags')
    .ilike('fansly_username', username)
    .single()

  if (!model) return NextResponse.json({ error: 'Model not found' }, { status: 404 })
  if (!model.branding_file_md) {
    return NextResponse.json({ error: 'Upload a branding file first' }, { status: 400 })
  }

  try {
    const hashtags = await suggestHashtags(model.branding_file_md, model.hashtags ?? [])
    return NextResponse.json({ hashtags })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[suggest hashtags]', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
