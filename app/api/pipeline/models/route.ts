import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('pipeline_models')
      .select('*')
      .order('handle')

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ models: data ?? [] })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { handle } = body
    if (!handle) return NextResponse.json({ error: 'handle required' }, { status: 400 })

    const { data, error } = await supabaseAdmin
      .from('pipeline_models')
      .insert({
        handle: handle.trim().toLowerCase(),
        videos_per_cycle: 6,
        flash_frame_enabled: false,
        active: true,
        niche_tags: [],
        kie_ref_urls: [],
      })
      .select('id')
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ id: data.id }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
