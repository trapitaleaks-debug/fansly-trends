'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import PostCard, { type Post, NICHES, NICHE_COLORS } from '@/components/PostCard'
import PostModal from '@/components/PostModal'

interface Idea {
  id: string
  niches: string[]
  tags: string[]
  notes: string
  trends_posts: Post
}

export default function IdeasPage() {
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [nicheCounts, setNicheCounts] = useState<Record<string, number>>({})
  const [activeNiche, setActiveNiche] = useState<string | null>(null)
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function loadIdeas(niche?: string | null) {
    setLoading(true)
    const params = niche ? `?niche=${encodeURIComponent(niche)}` : ''
    const res = await fetch(`/api/ideas${params}`)
    const data = await res.json()
    setIdeas(data.ideas ?? [])
    setLoading(false)
  }

  useEffect(() => {
    fetch('/api/ideas')
      .then(r => r.json())
      .then(({ ideas }) => {
        const all: Idea[] = ideas ?? []
        // Compute per-niche counts from all ideas
        const counts: Record<string, number> = {}
        for (const idea of all) {
          for (const n of (idea.niches ?? [])) {
            counts[n] = (counts[n] ?? 0) + 1
          }
        }
        setNicheCounts(counts)
        setIdeas(all)
        setLoading(false)
      })
  }, [])

  function handleNicheClick(niche: string | null) {
    setActiveNiche(niche)
    loadIdeas(niche)
  }

  function handleBookmarkChange() {
    // Reload all to update counts
    fetch('/api/ideas')
      .then(r => r.json())
      .then(({ ideas }) => {
        const all: Idea[] = ideas ?? []
        const counts: Record<string, number> = {}
        for (const idea of all) {
          for (const n of (idea.niches ?? [])) {
            counts[n] = (counts[n] ?? 0) + 1
          }
        }
        setNicheCounts(counts)
        if (!activeNiche) {
          setIdeas(all)
        } else {
          setIdeas(all.filter(i => (i.niches ?? []).includes(activeNiche)))
        }
      })
  }

  const totalCount = Object.values(nicheCounts).reduce((a, b) => a + b, 0)

  const displayPosts = ideas.map(i => ({
    ...i.trends_posts,
    trends_ideas: [{ id: i.id, niches: i.niches ?? [], tags: i.tags, notes: i.notes }],
  }))

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col">
      {/* Nav */}
      <nav className="bg-[#0f0f0f] border-b border-[#1e1e1e] px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <h1 className="text-sm font-bold text-white">FanslyTrends</h1>
        <div className="flex gap-4 text-xs text-[#666]">
          <Link href="/" className="hover:text-white transition-colors">Feed</Link>
          <span className="text-white">Ideas</span>
          <Link href="/models" className="hover:text-white transition-colors">Models</Link>
          <Link href="/pipeline" className="hover:text-white transition-colors">Pipeline</Link>
          <Link href="/templates" className="hover:text-white transition-colors">Templates</Link>
        </div>
      </nav>

      <div className="flex flex-1 min-h-0">
        {/* Sidebar — Niches */}
        <aside className="w-52 bg-[#0f0f0f] border-r border-[#1e1e1e] p-3 flex flex-col gap-0.5 flex-shrink-0 overflow-y-auto">
          <p className="text-[10px] font-medium text-[#444] uppercase tracking-wider px-3 py-1.5">Niches</p>

          <button
            onClick={() => handleNicheClick(null)}
            className={`text-left text-xs px-3 py-2 rounded-lg transition-colors flex items-center justify-between ${activeNiche === null ? 'bg-[#1e1e1e] text-white' : 'text-[#666] hover:text-white'}`}
          >
            <span>All Ideas</span>
            <span className="text-[10px] text-[#444]">{ideas.length}</span>
          </button>

          {NICHES.map(niche => {
            const count = nicheCounts[niche] ?? 0
            const isActive = activeNiche === niche
            return (
              <button
                key={niche}
                onClick={() => handleNicheClick(niche)}
                className={`text-left text-xs px-3 py-2 rounded-lg transition-colors flex items-center justify-between group ${isActive ? 'bg-[#1e1e1e] text-white' : count > 0 ? 'text-[#888] hover:text-white' : 'text-[#3a3a3a] hover:text-[#555]'}`}
              >
                <span className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${count > 0 ? (NICHE_COLORS[niche]?.match(/text-(\S+)-\d+/)?.[0]?.replace('text-', 'bg-') ?? 'bg-[#444]') : 'bg-[#2a2a2a]'}`} />
                  {niche}
                </span>
                {count > 0 && <span className="text-[10px] text-[#444]">{count}</span>}
              </button>
            )
          })}
        </aside>

        {/* Content */}
        <main className="flex-1 p-4 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-12">
              <div className="w-6 h-6 border-2 border-[#333] border-t-white rounded-full animate-spin" />
            </div>
          ) : displayPosts.length === 0 ? (
            <div className="text-center py-20 text-[#444]">
              {activeNiche ? (
                <>
                  <p className="text-lg mb-2">No ideas in "{activeNiche}"</p>
                  <p className="text-sm">Bookmark posts and tag them with this niche</p>
                </>
              ) : (
                <>
                  <p className="text-lg mb-2">No saved ideas yet</p>
                  <p className="text-sm">Star posts from the feed to save them here</p>
                </>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {displayPosts.map(post => (
                <PostCard
                  key={post.id}
                  post={post}
                  onClick={() => setSelectedPostId(post.id)}
                  onBookmark={() => setSelectedPostId(post.id)}
                />
              ))}
            </div>
          )}
        </main>
      </div>

      {selectedPostId && (
        <PostModal
          postId={selectedPostId}
          onClose={() => setSelectedPostId(null)}
          onBookmarkChange={handleBookmarkChange}
        />
      )}
    </div>
  )
}
