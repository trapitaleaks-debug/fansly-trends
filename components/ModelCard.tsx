'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useNiches } from '@/components/NichesProvider'

export interface ModelSummary {
  id: string
  fansly_username: string
  fansly_url: string | null
  niches: string[]
  model_number: number | null
  content_bank_count: number
  fancore_capacity?: number | null
  updated_at: string
}

export interface ScheduleSnapshot {
  model_id: string
  scraped_at: string
  scheduled_count: number
  posts: Array<{ scheduledAt: string; caption: string }>
  error?: string | null
}

function ScheduleBadge({
  snap,
  expanded,
  onToggle,
}: {
  snap: ScheduleSnapshot
  expanded: boolean
  onToggle: (e: React.MouseEvent) => void
}) {
  const { count, error } = snap

  let color = ''
  let label = ''
  if (error) {
    color = 'text-[#555] border-[#333] bg-[#1a1a1a]'
    label = 'Err'
  } else if (count < 4) {
    color = 'text-red-400 border-red-500/40 bg-red-500/10'
    label = `${count}/8`
  } else if (count < 8) {
    color = 'text-amber-400 border-amber-500/40 bg-amber-500/10'
    label = `${count}/8`
  } else {
    color = 'text-emerald-400 border-emerald-500/30 bg-emerald-500/8'
    label = `${count}/8`
  }

  return (
    <button
      onClick={onToggle}
      title={error ? `Error: ${error}` : `${count} hashtagged posts in next 48h`}
      className={`text-[10px] tabular-nums px-1.5 py-0.5 rounded border ${color} cursor-pointer hover:opacity-80 transition-opacity select-none`}
    >
      📅 {label} {expanded ? '▲' : '▼'}
    </button>
  )
}

function SchedulePanel({ snap }: { snap: ScheduleSnapshot }) {
  if (snap.error) {
    return (
      <div className="px-4 py-2 text-[11px] text-[#555] bg-[#080808] border-t border-[#1a1a1a]">
        Could not scrape: {snap.error}
      </div>
    )
  }

  if (snap.posts.length === 0) {
    return (
      <div className="px-4 py-2 text-[11px] text-[#444] bg-[#080808] border-t border-[#1a1a1a]">
        No hashtagged posts scheduled in next 48h
      </div>
    )
  }

  return (
    <div className="bg-[#080808] border-t border-[#1a1a1a] px-4 py-2 space-y-1">
      {snap.posts.map((p, i) => {
        const d = new Date(p.scheduledAt)
        const label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) +
          ' · ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) + ' UTC'
        return (
          <div key={i} className="flex gap-2 text-[11px]">
            <span className="text-[#555] shrink-0 tabular-nums">{label}</span>
            <span className="text-[#666] truncate">{p.caption.slice(0, 80)}</span>
          </div>
        )
      })}
      <div className="text-[10px] text-[#333] pt-0.5">
        Scraped {new Date(snap.scraped_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>
  )
}

export default function ModelCard({
  model,
  scheduleSnap,
}: {
  model: ModelSummary
  scheduleSnap?: ScheduleSnapshot
}) {
  const { nicheEmoji } = useNiches()
  const [schedExpanded, setSchedExpanded] = useState(false)

  return (
    <div className="border-b border-[#1a1a1a] group">
      <Link
        href={`/models/${model.fansly_username}`}
        className="flex items-center justify-between px-4 py-3 hover:bg-[#111] transition-colors"
      >
        <div className="flex items-center gap-3">
          {model.model_number != null && (
            <span className="text-xs text-[#444] w-6 text-right shrink-0">{model.model_number}</span>
          )}
          <span className="text-sm font-medium text-white">{model.fansly_username}</span>
        </div>
        <div className="flex items-center gap-3">
          {model.fancore_capacity != null && (
            <span
              title={`FanCore bulk-post records (cap ~1000). Auto-cleaned daily.`}
              className={`text-[10px] tabular-nums px-1.5 py-0.5 rounded border ${
                model.fancore_capacity >= 950 ? 'text-red-400 border-red-500/40 bg-red-500/10'
                : model.fancore_capacity >= 700 ? 'text-amber-400 border-amber-500/40 bg-amber-500/10'
                : 'text-[#555] border-[#242424]'
              }`}
            >
              FC {model.fancore_capacity}/1000
            </span>
          )}
          {scheduleSnap && (
            <ScheduleBadge
              snap={scheduleSnap}
              expanded={schedExpanded}
              onToggle={e => { e.preventDefault(); e.stopPropagation(); setSchedExpanded(v => !v) }}
            />
          )}
          <span className={`text-xs tabular-nums ${model.content_bank_count > 0 ? 'text-violet-400' : 'text-[#444]'}`}>
            {model.content_bank_count} {model.content_bank_count === 1 ? 'video' : 'videos'}
          </span>
          <span className="text-[#333] group-hover:text-[#666] transition-colors text-xs">→</span>
        </div>
      </Link>
      {scheduleSnap && schedExpanded && <SchedulePanel snap={scheduleSnap} />}
    </div>
  )
}
