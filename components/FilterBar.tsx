'use client'
import { NICHES } from './PostCard'

export interface Filters {
  sort: 'trending' | 'liked' | 'newest'
  days: number
  minLikes: number
  hashtag: string
  type: 'all' | 'explicit' | 'sfw'
  niche: string
  tagged: boolean
  hideBookmarked: boolean
}

interface Props {
  filters: Filters
  onChange: (f: Filters) => void
}

export default function FilterBar({ filters, onChange }: Props) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch })

  return (
    <div className="flex flex-wrap gap-2 px-4 py-3 bg-[#0f0f0f] border-b border-[#1e1e1e] text-xs">
      {/* Sort */}
      <select
        value={filters.sort}
        onChange={e => set({ sort: e.target.value as Filters['sort'] })}
        className="bg-[#1a1a1a] border border-[#2a2a2a] text-[#ccc] rounded-md px-2 py-1.5 focus:outline-none"
      >
        <option value="trending">🔥 Trending (24h)</option>
        <option value="liked">❤️ Most Liked</option>
        <option value="newest">🕐 Newest</option>
      </select>

      {/* Date */}
      <select
        value={filters.days}
        onChange={e => set({ days: parseInt(e.target.value) })}
        className="bg-[#1a1a1a] border border-[#2a2a2a] text-[#ccc] rounded-md px-2 py-1.5 focus:outline-none"
      >
        <option value={1}>Today</option>
        <option value={7}>7 days</option>
        <option value={30}>30 days</option>
        <option value={90}>90 days</option>
        <option value={0}>All time</option>
      </select>

      {/* Min likes */}
      <input
        type="number"
        placeholder="Min likes"
        value={filters.minLikes || ''}
        onChange={e => set({ minLikes: parseInt(e.target.value) || 0 })}
        className="bg-[#1a1a1a] border border-[#2a2a2a] text-[#ccc] rounded-md px-2 py-1.5 w-24 focus:outline-none placeholder-[#444]"
      />

      {/* Hashtag */}
      <input
        type="text"
        placeholder="#hashtag"
        value={filters.hashtag}
        onChange={e => set({ hashtag: e.target.value })}
        className="bg-[#1a1a1a] border border-[#2a2a2a] text-[#ccc] rounded-md px-2 py-1.5 w-28 focus:outline-none placeholder-[#444]"
      />

      {/* Type */}
      <select
        value={filters.type}
        onChange={e => set({ type: e.target.value as Filters['type'] })}
        className="bg-[#1a1a1a] border border-[#2a2a2a] text-[#ccc] rounded-md px-2 py-1.5 focus:outline-none"
      >
        <option value="all">All content</option>
        <option value="explicit">Explicit only</option>
        <option value="sfw">SFW only</option>
      </select>

      {/* Niche */}
      <select
        value={filters.niche}
        onChange={e => set({ niche: e.target.value, tagged: e.target.value !== '' })}
        className="bg-[#1a1a1a] border border-[#2a2a2a] text-[#ccc] rounded-md px-2 py-1.5 focus:outline-none"
      >
        <option value="">All niches</option>
        {NICHES.map(n => (
          <option key={n} value={n}>{n.charAt(0).toUpperCase() + n.slice(1)}</option>
        ))}
      </select>

      {/* Tagged only toggle */}
      {!filters.niche && (
        <button
          onClick={() => set({ tagged: !filters.tagged })}
          className={`px-3 py-1.5 rounded-md border text-xs transition-colors ${filters.tagged ? 'bg-[#D41020]/20 border-[#D41020]/40 text-[#D41020]' : 'border-[#2a2a2a] text-[#555] hover:border-[#3a3a3a] hover:text-[#888]'}`}
        >
          Tagged only
        </button>
      )}

      {/* Hide bookmarked toggle */}
      <button
        onClick={() => set({ hideBookmarked: !filters.hideBookmarked })}
        className={`px-3 py-1.5 rounded-md border text-xs transition-colors ${!filters.hideBookmarked ? 'bg-yellow-500/20 border-yellow-500/40 text-yellow-400' : 'border-[#2a2a2a] text-[#555] hover:border-[#3a3a3a] hover:text-[#888]'}`}
      >
        {filters.hideBookmarked ? 'Show bookmarks' : 'Hide bookmarks'}
      </button>
    </div>
  )
}
