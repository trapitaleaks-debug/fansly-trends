import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

const KEY = 'content_tags'
const DEFAULT_TAGS = ['masturbation', 'dildo', 'blowjob', 'girl/girl', 'all']

export async function GET() {
  const { data } = await supabaseAdmin
    .from('trends_settings')
    .select('value')
    .eq('key', KEY)
    .single()
  return NextResponse.json({ tags: (data?.value as string[]) ?? DEFAULT_TAGS })
}

export async function PUT(request: NextRequest) {
  const { tags } = await request.json()
  if (!Array.isArray(tags)) return NextResponse.json({ error: 'tags must be array' }, { status: 400 })
  const { error } = await supabaseAdmin
    .from('trends_settings')
    .upsert({ key: KEY, value: tags })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ tags })
}
