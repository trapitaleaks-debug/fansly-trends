import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import fs from 'fs'
import os from 'os'
import path from 'path'

export const maxDuration = 300

export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const results: string[] = []

  // ── Phase 1: start tasks for models with sheet_status='queued' ────────────
  const { data: queued } = await supabaseAdmin
    .from('pipeline_models')
    .select('*')
    .eq('sheet_status', 'queued')
    .order('created_at', { ascending: true })

  for (const model of queued ?? []) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kie_sheet_'))
    try {
      // Set to 'starting' immediately to prevent double-pickup if cron fires again before this finishes
      await supabaseAdmin.from('pipeline_models').update({ sheet_status: 'starting' }).eq('id', model.id)

      const { startCharacterSheetTask } = await import('@/pipeline/generate')
      await startCharacterSheetTask(model, tmpDir)
      results.push(`started:${model.handle}`)
    } catch (e) {
      console.error(`[cron] startCharacterSheetTask failed for @${model.handle}:`, (e as Error).message)
      await supabaseAdmin.from('pipeline_models').update({ sheet_status: 'error' }).eq('id', model.id)
      results.push(`start_error:${model.handle}`)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // ── Phase 2: check tasks for models with sheet_status='polling' ───────────
  const { data: polling } = await supabaseAdmin
    .from('pipeline_models')
    .select('*')
    .eq('sheet_status', 'polling')
    .order('created_at', { ascending: true })

  for (const model of polling ?? []) {
    try {
      const { checkCharacterSheetTask } = await import('@/pipeline/generate')
      await checkCharacterSheetTask(model)
      results.push(`checked:${model.handle}`)
    } catch (e) {
      console.error(`[cron] checkCharacterSheetTask failed for @${model.handle}:`, (e as Error).message)
      await supabaseAdmin.from('pipeline_models').update({ sheet_status: 'error' }).eq('id', model.id)
      results.push(`check_error:${model.handle}`)
    }
  }

  return NextResponse.json({ ok: true, results })
}
