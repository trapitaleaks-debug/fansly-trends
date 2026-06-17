'use client'
import Link from 'next/link'
import { useNiches } from '@/components/NichesProvider'

export interface ModelSummary {
  id: string
  fansly_username: string
  fansly_url: string | null
  niches: string[]
  model_number: number | null
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
        {model.niches.length > 0 && (
          <span className="text-xs text-[#555]">
            {model.niches.map(n => nicheEmoji(n)).join(' ')}
          </span>
        )}
      </div>
      <span className="text-[#333] group-hover:text-[#666] transition-colors text-xs">→</span>
    </Link>
  )
}
