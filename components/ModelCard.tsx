'use client'
import Link from 'next/link'

export interface ModelSummary {
  id: string
  fansly_username: string
  fansly_url: string | null
  hashtag_count: number
  suggestion_counts: { pending: number; done: number; dismissed: number }
  updated_at: string
}

export default function ModelCard({ model }: { model: ModelSummary }) {
  return (
    <Link
      href={`/models/${model.fansly_username}`}
      className="block bg-[#111] border border-[#1e1e1e] rounded-xl p-4 hover:border-[#333] transition-colors"
    >
      <p className="text-sm font-semibold text-white">@{model.fansly_username}</p>
      <p className="text-xs text-[#555] mt-0.5">{model.hashtag_count} hashtags</p>
    </Link>
  )
}
