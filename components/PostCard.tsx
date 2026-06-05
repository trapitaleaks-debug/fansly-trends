'use client'
import { useState } from 'react'

export interface Post {
  id: string
  fansly_post_id: string
  creator_username: string
  creator_fansly_url: string
  caption: string
  hashtags: string[]
  likes_current: number
  growth_24h_pct: number | null
  thumbnail_r2_key: string | null
  video_r2_key: string | null
  is_explicit: boolean
  scraped_at: string
  trends_ideas?: { id: string; folder: string; tags: string[]; notes: string }[]
}

interface Props {
  post: Post
  onClick: () => void
  onBookmark: () => void
}

function fmt(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

export default function PostCard({ post, onClick, onBookmark }: Props) {
  const [revealed, setRevealed] = useState(false)
  const isBookmarked = (post.trends_ideas?.length ?? 0) > 0
  const hasNote = post.trends_ideas?.[0]?.notes

  const growth = post.growth_24h_pct
  const growthLabel = growth !== null && growth !== undefined
    ? `${growth >= 0 ? '+' : ''}${growth.toFixed(0)}%`
    : null

  return (
    <div
      className="relative bg-[#111] border border-[#1e1e1e] rounded-xl overflow-hidden cursor-pointer group hover:border-[#333] transition-colors"
      onClick={onClick}
    >
      {/* Thumbnail */}
      <div className="aspect-[9/16] bg-[#0a0a0a] relative overflow-hidden">
        {post.thumbnail_r2_key ? (
          <img
            src={`/api/thumb/${post.id}`}
            alt=""
            className={`w-full h-full object-cover transition-all duration-300 ${revealed ? '' : 'blur-xl scale-105'}`}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[#333] text-sm">No preview</div>
        )}

        {/* Blur overlay */}
        {!revealed && post.is_explicit && (
          <button
            className="absolute inset-0 flex items-center justify-center"
            onClick={e => { e.stopPropagation(); setRevealed(true) }}
            title="Click to reveal"
          >
            <span className="bg-black/60 text-white text-xs px-3 py-1 rounded-full border border-white/20 backdrop-blur-sm">
              Click to reveal
            </span>
          </button>
        )}

        {/* Growth badge */}
        {growthLabel && (
          <div className={`absolute top-2 left-2 text-xs font-bold px-2 py-0.5 rounded-full ${growth! >= 0 ? 'bg-green-500/90 text-white' : 'bg-red-500/90 text-white'}`}>
            {growthLabel}
          </div>
        )}

        {/* Bookmark */}
        <button
          className={`absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center transition-colors ${isBookmarked ? 'bg-yellow-500 text-black' : 'bg-black/60 text-white hover:bg-black/80'}`}
          onClick={e => { e.stopPropagation(); onBookmark() }}
          title={isBookmarked ? 'Saved to Ideas' : 'Save to Ideas'}
        >
          {isBookmarked ? '★' : '☆'}
        </button>
      </div>

      {/* Info */}
      <div className="p-3 space-y-1">
        <div className="flex items-center justify-between">
          <a
            href={post.creator_fansly_url || `https://fansly.com/${post.creator_username}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-[#888] hover:text-white transition-colors"
            onClick={e => e.stopPropagation()}
          >
            @{post.creator_username}
          </a>
          <span className="text-xs text-[#555]">❤️ {fmt(post.likes_current)}</span>
        </div>
        {hasNote && (
          <p className="text-xs text-[#666] line-clamp-2 italic">"{hasNote}"</p>
        )}
      </div>
    </div>
  )
}
