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
  const pending = model.suggestion_counts.pending
  const done = model.suggestion_counts.done

  return (
    <Link
      href={`/models/${model.fansly_username}`}
      className="block bg-[#111] border border-[#1e1e1e] rounded-xl p-4 hover:border-[#333] transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-white">@{model.fansly_username}</p>
          <p className="text-xs text-[#555] mt-0.5">{model.hashtag_count} hashtags</p>
        </div>
        <div className="flex gap-2 text-xs">
          {pending > 0 && (
            <span className="bg-blue-500/15 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded-full">
              {pending} pending
            </span>
          )}
          {done > 0 && (
            <span className="bg-green-500/15 text-green-400 border border-green-500/20 px-2 py-0.5 rounded-full">
              {done} done
            </span>
          )}
        </div>
      </div>
      {pending === 0 && done === 0 && model.suggestion_counts.dismissed === 0 && (
        <p className="text-xs text-[#444] mt-2">No suggestions yet — upload branding file to start</p>
      )}
    </Link>
  )
}
