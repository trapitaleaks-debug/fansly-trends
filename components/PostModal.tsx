'use client'
import { useEffect, useState, useRef } from 'react'
import type { Post } from './PostCard'
import { useNiches } from './NichesProvider'

interface DetailPost extends Post {
  videoUrl?: string
  video_duration?: number
  post_date?: string
  text_template?: string | null
}

interface Props {
  postId: string
  onClose: () => void
  onBookmarkChange: () => void
}

export default function PostModal({ postId, onClose, onBookmarkChange }: Props) {
  const [post, setPost] = useState<DetailPost | null>(null)
  const [notes, setNotes] = useState('')
  const [textTemplate, setTextTemplate] = useState('')
  const [saving, setSaving] = useState(false)
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [ideaId, setIdeaId] = useState<string | null>(null)
  const [ideaNiches, setIdeaNiches] = useState<string[]>([])
  const [ideaTags, setIdeaTags] = useState<string[]>([])
  const [contentTags, setContentTags] = useState<string[]>([])
  const [bookmarking, setBookmarking] = useState(false)
  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const templateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { niches, badgeClass, nicheEmoji } = useNiches()

  useEffect(() => {
    fetch(`/api/posts/${postId}`)
      .then(r => r.json())
      .then(({ post }) => {
        setPost(post)
        setNotes(post?.trends_ideas?.[0]?.notes ?? '')
        setTextTemplate(post?.text_template ?? '')
        if (post?.trends_ideas?.[0]) {
          setIdeaId(post.trends_ideas[0].id)
          setIdeaNiches(post.trends_ideas[0].niches ?? [])
          setIdeaTags(post.trends_ideas[0].tags ?? [])
        }
      })

    fetch('/api/settings/content-tags')
      .then(r => r.json())
      .then(d => setContentTags(d.tags ?? []))

    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [postId, onClose])

  function handleTemplateChange(val: string) {
    setTextTemplate(val)
    if (templateTimer.current) clearTimeout(templateTimer.current)
    templateTimer.current = setTimeout(async () => {
      setSavingTemplate(true)
      await fetch(`/api/posts/${postId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text_template: val || null }),
      })
      setSavingTemplate(false)
    }, 800)
  }

  function handleNotesChange(val: string) {
    setNotes(val)
    if (!ideaId) return
    if (notesTimer.current) clearTimeout(notesTimer.current)
    notesTimer.current = setTimeout(async () => {
      setSaving(true)
      await fetch(`/api/ideas/${ideaId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: val }),
      })
      setSaving(false)
    }, 800)
  }

  async function toggleIdeaNiche(niche: string) {
    const next = ideaNiches.includes(niche)
      ? ideaNiches.filter(n => n !== niche)
      : [...ideaNiches, niche]
    setIdeaNiches(next)
    if (ideaId) {
      await fetch(`/api/ideas/${ideaId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ niches: next }),
      })
      onBookmarkChange()
    }
  }

  async function toggleIdeaTag(tag: string) {
    if (!ideaId) return
    const next = ideaTags.includes(tag)
      ? ideaTags.filter(t => t !== tag)
      : [...ideaTags, tag]
    setIdeaTags(next)
    await fetch(`/api/ideas/${ideaId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: next }),
    })
  }

  async function handleBookmark() {
    setBookmarking(true)
    const res = await fetch('/api/ideas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post_id: postId, niches: [], notes }),
    })
    const data = await res.json()
    const newId = data.idea?.id ?? null
    setIdeaId(newId)
    setIdeaNiches([])
    setBookmarking(false)
    setPost(p => p ? {
      ...p,
      trends_ideas: [{ id: newId ?? 'new', niches: [], tags: [], notes }],
    } : p)
    onBookmarkChange()
  }

  async function handleRemoveBookmark() {
    if (!ideaId) return
    await fetch(`/api/ideas/${ideaId}`, { method: 'DELETE' })
    setIdeaId(null)
    setIdeaNiches([])
    setPost(p => p ? { ...p, trends_ideas: [] } : p)
    onBookmarkChange()
  }

  if (!post) {
    return (
      <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center">
        <div className="text-[#666] text-sm">Loading...</div>
      </div>
    )
  }

  const isBookmarked = ideaId !== null
  const growth = post.growth_24h_pct
  const growthLabel = growth !== null && growth !== undefined
    ? `${growth >= 0 ? '+' : ''}${growth.toFixed(1)}% 24h`
    : null

  return (
    <div className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-[#111] border border-[#222] rounded-2xl overflow-hidden w-full max-w-3xl max-h-[90vh] flex flex-col md:flex-row"
        onClick={e => e.stopPropagation()}
      >
        {/* Video */}
        <div className="w-full md:w-64 flex-shrink-0 bg-black flex items-center justify-center min-h-[300px]">
          {post.videoUrl ? (
            <video
              src={post.videoUrl}
              autoPlay
              muted
              loop
              controls
              playsInline
              className="w-full h-full object-contain max-h-[80vh]"
            />
          ) : (
            <div className="text-[#444] text-sm p-8 text-center">
              {post.video_r2_key ? 'Loading video...' : 'No video available'}
            </div>
          )}
        </div>

        {/* Details */}
        <div className="flex-1 p-5 overflow-y-auto flex flex-col gap-4 min-w-0">
          {/* Header */}
          <div className="flex items-start justify-between gap-2">
            <div>
              <a
                href={post.creator_fansly_url || `https://fansly.com/${post.creator_username}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-white font-semibold hover:underline"
              >
                @{post.creator_username}
              </a>
              {post.post_date && (
                <p className="text-[#555] text-xs mt-0.5">{new Date(post.post_date).toLocaleDateString()}</p>
              )}
            </div>
            <button onClick={onClose} className="text-[#555] hover:text-white text-xl flex-shrink-0">✕</button>
          </div>

          {/* Stats */}
          <div className="flex gap-4 text-sm">
            <span className="text-[#888]">❤️ <strong className="text-white">{post.likes_current.toLocaleString()}</strong> likes</span>
            {growthLabel && (
              <span className={growth! >= 0 ? 'text-green-400' : 'text-red-400'}>
                {growthLabel}
              </span>
            )}
          </div>

          {/* Caption */}
          {post.caption && (
            <p className="text-[#888] text-sm leading-relaxed">{post.caption}</p>
          )}

          {/* Hashtags */}
          {post.hashtags?.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {post.hashtags.map(tag => (
                <span key={tag} className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] px-2 py-0.5 rounded-full">
                  #{tag}
                </span>
              ))}
            </div>
          )}

          {/* Text Template */}
          <div>
            <label className="text-xs text-[#555] mb-1 block flex items-center justify-between">
              <span>Text template <span className="text-[#3a3a3a]">— one line per overlay</span></span>
              {savingTemplate && <span className="text-[#3a3a3a]">saving...</span>}
              {textTemplate && !savingTemplate && <span className="text-[#D41020] text-[10px] font-medium">● saved</span>}
            </label>
            <textarea
              value={textTemplate}
              onChange={e => handleTemplateChange(e.target.value)}
              placeholder={"POV you found a nice girl\nwho actually likes you back"}
              rows={3}
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-sm text-white placeholder-[#2e2e2e] focus:outline-none focus:border-[#D41020]/40 resize-none font-mono leading-relaxed"
            />
          </div>

          {/* Notes */}
          <div>
            <label className="text-xs text-[#555] mb-1.5 block">
              Notes {saving && <span className="text-[#444]">saving...</span>}
            </label>
            <textarea
              value={notes}
              onChange={e => handleNotesChange(e.target.value)}
              placeholder="Add your notes about this post..."
              rows={3}
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#444] resize-none"
            />
          </div>

          {/* Bookmark section */}
          <div className="space-y-3">
            {isBookmarked ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-yellow-400 font-medium">★ Saved to Ideas</span>
                  <span className="text-[10px] text-[#444]">— tap niches to update</span>
                </div>
                {/* Niche picker */}
                <div className="flex flex-wrap gap-1.5">
                  {niches.map(n => (
                    <button
                      key={n.name}
                      onClick={() => toggleIdeaNiche(n.name)}
                      className={`text-[10px] font-medium px-2.5 py-1 rounded-full border transition-colors ${ideaNiches.includes(n.name) ? badgeClass(n.name) : 'border-[#2a2a2a] text-[#444] hover:border-[#3a3a3a] hover:text-[#666]'}`}
                    >
                      {n.emoji} {n.name}
                    </button>
                  ))}
                </div>

                {/* Tag picker */}
                {contentTags.length > 0 && (
                  <div className="space-y-1.5">
                    <span className="text-[10px] text-[#444]">Content type</span>
                    <div className="flex flex-wrap gap-1.5">
                      {contentTags.map(tag => (
                        <button
                          key={tag}
                          onClick={() => toggleIdeaTag(tag)}
                          className={`text-[10px] font-medium px-2.5 py-1 rounded-full border transition-colors ${ideaTags.includes(tag) ? 'bg-violet-500/20 border-violet-500/40 text-violet-300' : 'border-[#2a2a2a] text-[#444] hover:border-[#3a3a3a] hover:text-[#666]'}`}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <button
                  onClick={handleRemoveBookmark}
                  className="text-xs text-[#444] hover:text-red-400 transition-colors"
                >
                  Remove bookmark
                </button>
              </div>
            ) : (
              <button
                onClick={handleBookmark}
                disabled={bookmarking}
                className="text-sm px-4 py-2 rounded-lg font-medium bg-[#1a1a1a] text-[#999] border border-[#2a2a2a] hover:border-[#444] disabled:opacity-50 transition-colors"
              >
                {bookmarking ? 'Saving...' : '☆ Save to Ideas'}
              </button>
            )}
          </div>

          {/* View on Fansly */}
          <a
            href={`https://fansly.com/post/${post.fansly_post_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-[#555] hover:text-[#888] transition-colors"
          >
            View on Fansly ↗
          </a>
        </div>
      </div>
    </div>
  )
}
