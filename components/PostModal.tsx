'use client'
import { useEffect, useState, useRef } from 'react'
import type { Post } from './PostCard'
import { NICHES, NICHE_COLORS } from './PostCard'

interface DetailPost extends Post {
  videoUrl?: string
  video_duration?: number
  post_date?: string
  text_template?: string | null
  niche_tags?: string[]
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
  const [nicheTags, setNicheTags] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [ideaId, setIdeaId] = useState<string | null>(null)
  const [ideaNiches, setIdeaNiches] = useState<string[]>([])
  const [showNichePicker, setShowNichePicker] = useState(false)
  const [bookmarking, setBookmarking] = useState(false)
  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const templateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    fetch(`/api/posts/${postId}`)
      .then(r => r.json())
      .then(({ post }) => {
        setPost(post)
        setNotes(post?.trends_ideas?.[0]?.notes ?? '')
        setTextTemplate(post?.text_template ?? '')
        setNicheTags(post?.niche_tags ?? [])
        if (post?.trends_ideas?.[0]) {
          setIdeaId(post.trends_ideas[0].id)
          setIdeaNiches(post.trends_ideas[0].niches ?? [])
        }
      })

    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [postId, onClose])

  async function handleNicheToggle(niche: string) {
    const next = nicheTags.includes(niche)
      ? nicheTags.filter(t => t !== niche)
      : [...nicheTags, niche]
    setNicheTags(next)
    await fetch(`/api/posts/${postId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ niche_tags: next }),
    })
  }

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

  function toggleIdeaNiche(niche: string) {
    setIdeaNiches(prev =>
      prev.includes(niche) ? prev.filter(n => n !== niche) : [...prev, niche]
    )
  }

  async function handleBookmark() {
    setBookmarking(true)
    const res = await fetch('/api/ideas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post_id: postId, niches: ideaNiches, notes }),
    })
    const data = await res.json()
    setIdeaId(data.idea?.id ?? ideaId)
    setShowNichePicker(false)
    setBookmarking(false)
    setPost(p => p ? {
      ...p,
      trends_ideas: [{ id: data.idea?.id ?? 'new', niches: ideaNiches, tags: [], notes }],
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

          {/* Niche Tags (content tags for feed filter) */}
          <div>
            <label className="text-xs text-[#555] mb-2 block">Niche tags <span className="text-[#333]">— for feed filter</span></label>
            <div className="flex flex-wrap gap-1.5">
              {NICHES.map(niche => {
                const active = nicheTags.includes(niche)
                return (
                  <button
                    key={niche}
                    onClick={() => handleNicheToggle(niche)}
                    className={`text-[10px] font-medium px-2.5 py-1 rounded-full border transition-colors ${active ? NICHE_COLORS[niche] : 'border-[#2a2a2a] text-[#444] hover:border-[#3a3a3a] hover:text-[#666]'}`}
                  >
                    {niche}
                  </button>
                )
              })}
            </div>
          </div>

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
                {/* Saved indicator + niche chips */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-yellow-400 font-medium">★ Saved to Ideas</span>
                  {ideaNiches.map(n => (
                    <span key={n} className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${NICHE_COLORS[n] ?? 'bg-[#1a1a1a] border-[#2a2a2a] text-[#666]'}`}>
                      {n}
                    </span>
                  ))}
                </div>
                {/* Edit niches */}
                <div>
                  <button
                    onClick={() => setShowNichePicker(v => !v)}
                    className="text-xs text-[#555] hover:text-white transition-colors"
                  >
                    {showNichePicker ? '− Hide niche picker' : '+ Change niches'}
                  </button>
                  {showNichePicker && (
                    <div className="mt-2 space-y-2">
                      <div className="flex flex-wrap gap-1.5">
                        {NICHES.map(niche => (
                          <button
                            key={niche}
                            onClick={() => toggleIdeaNiche(niche)}
                            className={`text-[10px] font-medium px-2.5 py-1 rounded-full border transition-colors ${ideaNiches.includes(niche) ? NICHE_COLORS[niche] : 'border-[#2a2a2a] text-[#444] hover:border-[#3a3a3a] hover:text-[#666]'}`}
                          >
                            {niche}
                          </button>
                        ))}
                      </div>
                      <button
                        onClick={handleBookmark}
                        disabled={bookmarking}
                        className="text-xs bg-yellow-500 text-black font-semibold px-4 py-1.5 rounded-lg hover:bg-yellow-400 disabled:opacity-50 transition-colors"
                      >
                        {bookmarking ? 'Saving...' : 'Save changes'}
                      </button>
                    </div>
                  )}
                </div>
                <button
                  onClick={handleRemoveBookmark}
                  className="text-xs text-[#444] hover:text-red-400 transition-colors"
                >
                  Remove bookmark
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {showNichePicker ? (
                  <div className="space-y-2">
                    <p className="text-xs text-[#555]">Save to niches:</p>
                    <div className="flex flex-wrap gap-1.5">
                      {NICHES.map(niche => (
                        <button
                          key={niche}
                          onClick={() => toggleIdeaNiche(niche)}
                          className={`text-[10px] font-medium px-2.5 py-1 rounded-full border transition-colors ${ideaNiches.includes(niche) ? NICHE_COLORS[niche] : 'border-[#2a2a2a] text-[#444] hover:border-[#3a3a3a] hover:text-[#666]'}`}
                        >
                          {niche}
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={handleBookmark}
                        disabled={bookmarking}
                        className="text-xs bg-yellow-500 text-black font-semibold px-4 py-1.5 rounded-lg hover:bg-yellow-400 disabled:opacity-50 transition-colors"
                      >
                        {bookmarking ? 'Saving...' : 'Save to Ideas'}
                      </button>
                      <button
                        onClick={() => { setShowNichePicker(false); setIdeaNiches([]) }}
                        className="text-xs text-[#555] hover:text-white transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowNichePicker(true)}
                    className="text-sm px-4 py-2 rounded-lg font-medium bg-[#1a1a1a] text-[#999] border border-[#2a2a2a] hover:border-[#444] transition-colors"
                  >
                    ☆ Save to Ideas
                  </button>
                )}
              </div>
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
