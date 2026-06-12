'use client'
import { useEffect, useState, useRef } from 'react'
import type { Post } from './PostCard'

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
  const [showBookmarkMenu, setShowBookmarkMenu] = useState(false)
  const [folder, setFolder] = useState('')
  const [folders, setFolders] = useState<string[]>([])
  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const templateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    fetch(`/api/posts/${postId}`)
      .then(r => r.json())
      .then(({ post }) => {
        setPost(post)
        setNotes(post?.trends_ideas?.[0]?.notes ?? '')
        setTextTemplate(post?.text_template ?? '')
      })
    fetch('/api/ideas')
      .then(r => r.json())
      .then(({ ideas }) => {
        const unique = [...new Set((ideas ?? []).map((i: { folder: string }) => i.folder).filter(Boolean))] as string[]
        setFolders(unique)
      })

    // close on escape
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
    if (notesTimer.current) clearTimeout(notesTimer.current)
    notesTimer.current = setTimeout(async () => {
      setSaving(true)
      await fetch(`/api/posts/${postId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: val }),
      })
      setSaving(false)
    }, 800)
  }

  async function handleBookmark() {
    await fetch('/api/ideas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post_id: postId, folder: folder || null, notes }),
    })
    setShowBookmarkMenu(false)
    onBookmarkChange()
    setPost(p => p ? { ...p, trends_ideas: [{ id: 'new', folder, tags: [], notes }] } : p)
  }

  if (!post) {
    return (
      <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center">
        <div className="text-[#666] text-sm">Loading...</div>
      </div>
    )
  }

  const isBookmarked = (post.trends_ideas?.length ?? 0) > 0
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

          {/* Bookmark */}
          <div className="relative">
            <button
              onClick={() => setShowBookmarkMenu(!showBookmarkMenu)}
              className={`text-sm px-4 py-2 rounded-lg font-medium transition-colors ${isBookmarked ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30' : 'bg-[#1a1a1a] text-[#999] border border-[#2a2a2a] hover:border-[#444]'}`}
            >
              {isBookmarked ? '★ Saved to Ideas' : '☆ Save to Ideas'}
            </button>

            {showBookmarkMenu && (
              <div className="absolute bottom-full left-0 mb-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-4 w-64 shadow-2xl z-10">
                <p className="text-xs text-[#666] mb-2">Save to folder</p>
                <input
                  list="folders"
                  value={folder}
                  onChange={e => setFolder(e.target.value)}
                  placeholder="Folder name (optional)"
                  className="w-full bg-[#111] border border-[#333] rounded-lg px-3 py-2 text-sm text-white placeholder-[#444] focus:outline-none mb-2"
                />
                <datalist id="folders">
                  {folders.map(f => <option key={f} value={f} />)}
                </datalist>
                <button
                  onClick={handleBookmark}
                  className="w-full bg-yellow-500 text-black font-semibold py-2 rounded-lg text-sm hover:bg-yellow-400 transition-colors"
                >
                  Save
                </button>
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
