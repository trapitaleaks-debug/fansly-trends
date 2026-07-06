'use client'
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

export default function ModelCard({ model }: { model: ModelSummary }) {
  const { nicheEmoji } = useNiches()

  return (
    <Link
      href={`/models/${model.fansly_username}`}
      className="flex items-center justify-between px-4 py-3 border-b border-[#1a1a1a] hover:bg-[#111] transition-colors group"
    >
      <div className="flex items-center gap-3">
        {model.model_number != null && (
          <span className="text-xs text-[#444] w-6 text-right shrink-0">{model.model_number}</span>
        )}
        <span className="text-sm font-medium text-white">{model.fansly_username}</span>
      </div>
      <div className="flex items-center gap-3">
        {model.fancore_capacity != null && (
          // FanCore bulk-post storage: silent-drop cap at ~1000 records. Watchdog auto-cleans
          // failed records daily; this badge is the early visual warning.
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
        <span className={`text-xs tabular-nums ${model.content_bank_count > 0 ? 'text-violet-400' : 'text-[#444]'}`}>
          {model.content_bank_count} {model.content_bank_count === 1 ? 'video' : 'videos'}
        </span>
        <span className="text-[#333] group-hover:text-[#666] transition-colors text-xs">→</span>
      </div>
    </Link>
  )
}
