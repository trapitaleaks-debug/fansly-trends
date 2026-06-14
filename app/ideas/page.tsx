'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import PostCard, { type Post } from '@/components/PostCard'
import PostModal from '@/components/PostModal'
import { useNiches } from '@/components/NichesProvider'

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
  const [showAddNiche, setShowAddNiche] = useState(false)
  const [newNicheName, setNewNicheName] = useState('')
  const [newNicheEmoji, setNewNicheEmoji] = useState('')
  const [addingNiche, setAddingNiche] = useState(false)
  const { niches, badgeClass, dotClass, nicheEmoji, addNiche, deleteNiche } = useNiches()

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

  async function handleAddNiche() {
    if (!newNicheName.trim() || !newNicheEmoji.trim()) return
    setAddingNiche(true)
    await addNiche(newNicheName, newNicheEmoji)
    setNewNicheName('')
    setNewNicheEmoji('')
    setShowAddNiche(false)
    setAddingNiche(false)
  }

  async function handleDeleteNiche(name: string) {
    if (activeNiche === name) setActiveNiche(null)
    await deleteNiche(name)
    // Reload ideas if the deleted niche was the active filter
    if (activeNiche === name) loadIdeas(null)
  }

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

          {niches.map(niche => {
            const count = nicheCounts[niche.name] ?? 0
            const isActive = activeNiche === niche.name
            return (
              <div key={niche.name} className="flex items-center group">
                <button
                  onClick={() => handleNicheClick(niche.name)}
                  className={`flex-1 text-left text-xs px-3 py-2 rounded-lg transition-colors flex items-center justify-between ${isActive ? 'bg-[#1e1e1e] text-white' : count > 0 ? 'text-[#888] hover:text-white' : 'text-[#3a3a3a] hover:text-[#555]'}`}
                >
                  <span className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${count > 0 ? dotClass(niche.name) : 'bg-[#2a2a2a]'}`} />
                    <span>{niche.emoji} {niche.name}</span>
                  </span>
                  {count > 0 && <span className="text-[10px] text-[#444]">{count}</span>}
                </button>
                <button
                  onClick={() => handleDeleteNiche(niche.name)}
                  className="opacity-0 group-hover:opacity-100 text-[#444] hover:text-red-400 transition-all px-1 text-xs flex-shrink-0"
                  title={`Remove ${niche.name}`}
                >
                  ✕
                </button>
              </div>
            )
          })}

          {/* Add niche */}
          <div className="mt-2 px-1">
            {showAddNiche ? (
              <div className="space-y-1.5">
                <div className="flex gap-1">
                  <input
                    type="text"
                    value={newNicheEmoji}
                    onChange={e => setNewNicheEmoji(e.target.value)}
                    placeholder="😀"
                    className="w-10 bg-[#1a1a1a] border border-[#2a2a2a] rounded-md px-1.5 py-1 text-xs text-white placeholder-[#444] focus:outline-none focus:border-[#444] text-center"
                    maxLength={2}
                  />
                  <input
                    type="text"
                    value={newNicheName}
                    onChange={e => setNewNicheName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAddNiche()}
                    placeholder="niche name"
                    className="flex-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded-md px-2 py-1 text-xs text-white placeholder-[#444] focus:outline-none focus:border-[#444]"
                    autoFocus
                  />
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={handleAddNiche}
                    disabled={addingNiche || !newNicheName.trim() || !newNicheEmoji.trim()}
                    className="flex-1 text-[10px] bg-[#D41020] text-white font-medium px-2 py-1 rounded-md disabled:opacity-40 hover:bg-[#e01a24] transition-colors"
                  >
                    {addingNiche ? '...' : 'Add'}
                  </button>
                  <button
                    onClick={() => { setShowAddNiche(false); setNewNicheName(''); setNewNicheEmoji('') }}
                    className="text-[10px] text-[#555] hover:text-white px-2 py-1"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowAddNiche(true)}
                className="text-[10px] text-[#444] hover:text-white transition-colors px-2 py-1 flex items-center gap-1"
              >
                <span>＋</span> Add niche
              </button>
            )}
          </div>
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
