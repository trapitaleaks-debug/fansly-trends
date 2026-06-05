'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import PostCard, { type Post } from '@/components/PostCard'
import PostModal from '@/components/PostModal'

interface Idea {
  id: string
  folder: string | null
  tags: string[]
  notes: string
  trends_posts: Post
}

export default function IdeasPage() {
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [activeFolder, setActiveFolder] = useState<string | null>(null)
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function loadIdeas(folder?: string | null) {
    setLoading(true)
    const params = folder ? `?folder=${encodeURIComponent(folder)}` : ''
    const res = await fetch(`/api/ideas${params}`)
    const data = await res.json()
    setIdeas(data.ideas ?? [])
    setLoading(false)
  }

  useEffect(() => {
    fetch('/api/ideas')
      .then(r => r.json())
      .then(({ ideas }) => {
        const unique = [...new Set((ideas ?? []).map((i: Idea) => i.folder).filter(Boolean))] as string[]
        setFolders(unique)
        setIdeas(ideas ?? [])
        setLoading(false)
      })
  }, [])

  function handleFolderClick(folder: string | null) {
    setActiveFolder(folder)
    loadIdeas(folder)
  }

  const displayPosts = ideas.map(i => ({
    ...i.trends_posts,
    trends_ideas: [{ id: i.id, folder: i.folder ?? '', tags: i.tags, notes: i.notes }],
  }))

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col">
      {/* Nav */}
      <nav className="bg-[#0f0f0f] border-b border-[#1e1e1e] px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <h1 className="text-sm font-bold text-white">FanslyTrends</h1>
        <div className="flex gap-4 text-xs text-[#666]">
          <Link href="/" className="hover:text-white transition-colors">Feed</Link>
          <span className="text-white">Ideas</span>
          <Link href="/settings" className="hover:text-white transition-colors">Settings</Link>
        </div>
      </nav>

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <aside className="w-48 bg-[#0f0f0f] border-r border-[#1e1e1e] p-3 flex flex-col gap-1 flex-shrink-0">
          <button
            onClick={() => handleFolderClick(null)}
            className={`text-left text-xs px-3 py-2 rounded-lg transition-colors ${activeFolder === null ? 'bg-[#1e1e1e] text-white' : 'text-[#666] hover:text-white'}`}
          >
            All Ideas ({ideas.length})
          </button>
          {folders.map(folder => (
            <button
              key={folder}
              onClick={() => handleFolderClick(folder)}
              className={`text-left text-xs px-3 py-2 rounded-lg transition-colors truncate ${activeFolder === folder ? 'bg-[#1e1e1e] text-white' : 'text-[#666] hover:text-white'}`}
            >
              📁 {folder}
            </button>
          ))}
        </aside>

        {/* Content */}
        <main className="flex-1 p-4">
          {loading ? (
            <div className="flex justify-center py-12">
              <div className="w-6 h-6 border-2 border-[#333] border-t-white rounded-full animate-spin" />
            </div>
          ) : displayPosts.length === 0 ? (
            <div className="text-center py-20 text-[#444]">
              <p className="text-lg mb-2">No saved ideas yet</p>
              <p className="text-sm">Star posts from the feed to save them here</p>
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
          onBookmarkChange={() => loadIdeas(activeFolder)}
        />
      )}
    </div>
  )
}
