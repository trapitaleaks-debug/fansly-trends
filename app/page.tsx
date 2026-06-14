'use client'
import { useState, useEffect, useCallback } from 'react'
import BenchmarkBar from '@/components/BenchmarkBar'
import FilterBar, { type Filters } from '@/components/FilterBar'
import PostCard, { type Post } from '@/components/PostCard'
import PostModal from '@/components/PostModal'
import Link from 'next/link'

const DEFAULT_FILTERS: Filters = {
  sort: 'trending',
  days: 7,
  minLikes: 0,
  hashtag: '',
  niche: '',
  hideBookmarked: true,
  showHidden: false,
}

export default function FeedPage() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null)

  const fetchPosts = useCallback(async (f: Filters, p: number, replace: boolean) => {
    setLoading(true)
    const params = new URLSearchParams({
      sort: f.sort,
      days: String(f.days),
      minLikes: String(f.minLikes),
      hashtag: f.hashtag,
      niche: f.niche,
      hide_bookmarked: f.hideBookmarked ? 'yes' : '',
      show_hidden: f.showHidden ? 'yes' : '',
      page: String(p),
    })
    const res = await fetch(`/api/posts?${params}`)
    const data = await res.json()
    const newPosts = data.posts ?? []
    setPosts(prev => replace ? newPosts : [...prev, ...newPosts])
    setHasMore(newPosts.length === 30)
    setLoading(false)
  }, [])

  useEffect(() => {
    setPage(0)
    fetchPosts(filters, 0, true)
  }, [filters, fetchPosts])

  function handleLoadMore() {
    const next = page + 1
    setPage(next)
    fetchPosts(filters, next, false)
  }

  function handleBookmarkChange() {
    fetchPosts(filters, 0, true)
    setPage(0)
  }

  async function handleHide(postId: string) {
    await fetch(`/api/posts/${postId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden_at: new Date().toISOString() }),
    })
    setPosts(prev => prev.filter(p => p.id !== postId))
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <nav className="bg-[#0f0f0f] border-b border-[#1e1e1e] px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <h1 className="text-sm font-bold text-white">FanslyTrends</h1>
        <div className="flex gap-4 text-xs text-[#666]">
          <span className="text-white">Feed</span>
          <Link href="/ideas" className="hover:text-white transition-colors">Ideas</Link>
          <Link href="/models" className="hover:text-white transition-colors">Models</Link>
          
          <Link href="/pipeline" className="hover:text-white transition-colors">Pipeline</Link>
          <Link href="/templates" className="hover:text-white transition-colors">Templates</Link>
        </div>
      </nav>

      <BenchmarkBar />
      <FilterBar filters={filters} onChange={setFilters} />

      <div className="p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {posts.map(post => (
          <PostCard
            key={post.id}
            post={post}
            onClick={() => setSelectedPostId(post.id)}
            onBookmark={() => setSelectedPostId(post.id)}
            onHide={!filters.showHidden ? () => handleHide(post.id) : undefined}
          />
        ))}
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <div className="w-6 h-6 border-2 border-[#333] border-t-white rounded-full animate-spin" />
        </div>
      )}

      {!loading && posts.length === 0 && (
        <div className="text-center py-20 text-[#444]">
          <p className="text-lg mb-2">No posts found</p>
          <p className="text-sm">Try adjusting your filters or run the scraper first</p>
        </div>
      )}

      {!loading && hasMore && posts.length > 0 && (
        <div className="flex justify-center py-8">
          <button
            onClick={handleLoadMore}
            className="bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:text-white hover:border-[#444] px-6 py-2 rounded-lg text-sm transition-colors"
          >
            Load more
          </button>
        </div>
      )}

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
