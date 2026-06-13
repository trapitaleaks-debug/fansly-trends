'use client'
import { useState } from 'react'

export interface Post {
  id: string
  fansly_post_id: string
  creator_username: string
  creator_fansly_url: string
  caption: string
  hashtags: string[]
  niche_tags?: string[]
  likes_current: number
  growth_24h_pct: number | null
  thumbnail_r2_key: string | null
  video_r2_key: string | null
  is_explicit: boolean
  scraped_at: string
  trends_ideas?: { id: string; niches: string[]; tags: string[]; notes: string }[]
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
  const ideaNiches = post.trends_ideas?.[0]?.niches ?? []
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
        {ideaNiches.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-0.5">
            {ideaNiches.map(tag => (
              <span key={tag} className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full border ${NICHE_COLORS[tag] ?? 'bg-[#1a1a1a] border-[#2a2a2a] text-[#666]'}`}>
                {tag}
              </span>
            ))}
          </div>
        )}
        {hasNote && (
          <p className="text-xs text-[#666] line-clamp-2 italic">"{hasNote}"</p>
        )}
      </div>
    </div>
  )
}

export const NICHES = ['general', 'asian', 'teen', 'latina', 'european', 'milf', 'ebony', 'petite', 'bbw', 'gfe', 'muslim', 'trans'] as const

export const NICHE_COLORS: Record<string, string> = {
  general:   'bg-blue-500/10 border-blue-500/20 text-blue-400',
  asian:     'bg-pink-500/10 border-pink-500/20 text-pink-400',
  teen:      'bg-purple-500/10 border-purple-500/20 text-purple-400',
  latina:    'bg-orange-500/10 border-orange-500/20 text-orange-400',
  european:  'bg-sky-500/10 border-sky-500/20 text-sky-400',
  milf:      'bg-rose-500/10 border-rose-500/20 text-rose-400',
  ebony:     'bg-amber-500/10 border-amber-500/20 text-amber-400',
  petite:    'bg-teal-500/10 border-teal-500/20 text-teal-400',
  bbw:       'bg-lime-500/10 border-lime-500/20 text-lime-400',
  gfe:       'bg-red-500/10 border-red-500/20 text-red-400',
  muslim:    'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
  trans:     'bg-violet-500/10 border-violet-500/20 text-violet-400',
}
