'use client'
import { useState, useCallback, useEffect } from 'react'

interface Post {
  id: string
  fansly_post_id: string
  creator_username: string
  creator_fansly_url: string | null
  likes_current: number
  thumbnail_r2_key: string | null
  caption: string
  hashtags: string[]
}

export interface Suggestion {
  id: string
  reasoning: string
  branding_section: string
  what_to_change: string
  status: 'pending' | 'done' | 'approved' | 'dismissed'
  notes: string | null
  dismiss_reason: string | null
  generated_at: string
  score_hook: number | null
  score_replayability: number | null
  score_retention: number | null
  score_payoff: number | null
  score_video_quality: number | null
  score_sexuality: number | null
  score_text_captions: number | null
  score_background: number | null
  score_total: number | null
  trends_posts: Post
}

const SCORE_DIMS: { key: keyof Suggestion; label: string }[] = [
  { key: 'score_hook', label: 'Hook' },
  { key: 'score_replayability', label: 'Replayability' },
  { key: 'score_retention', label: 'Retention' },
  { key: 'score_payoff', label: 'Payoff' },
  { key: 'score_video_quality', label: 'Video Quality' },
  { key: 'score_sexuality', label: 'Sexuality Cal.' },
  { key: 'score_text_captions', label: 'Text/Caption' },
  { key: 'score_background', label: 'Background' },
]

function ScoreBadge({ total, onClick }: { total: number | null; onClick: (e: React.MouseEvent) => void }) {
  if (total === null) return null
  const color = total >= 60 ? 'text-green-400 border-green-500/30 bg-green-500/10'
    : total >= 50 ? 'text-yellow-400 border-yellow-500/30 bg-yellow-500/10'
    : 'text-red-400 border-red-500/30 bg-red-500/10'
  return (
    <button
      onClick={onClick}
      className={`text-xs font-mono font-semibold px-2 py-0.5 rounded border ${color} transition-opacity hover:opacity-80`}
      title="Toggle score breakdown"
    >
      {total}/80 ▾
    </button>
  )
}

function ScoreBar({ value }: { value: number | null }) {
  if (value === null) return <span className="text-[#444] text-xs">—</span>
  const pct = (value / 10) * 100
  const color = value >= 7 ? 'bg-green-500' : value >= 5 ? 'bg-yellow-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-[#222] rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-[#666] w-4 text-right">{value}</span>
    </div>
  )
}

interface Props {
  suggestion: Suggestion
  onStatusChange: (id: string, status: 'pending' | 'done' | 'approved' | 'dismissed', dismissReason?: string) => void
  onWhatToChangeEdit: (id: string, whatToChange: string) => void
}

function fmt(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function VideoModal({ videoUrl, onClose }: { videoUrl: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="relative max-w-sm w-full"
        onClick={e => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute -top-8 right-0 text-[#888] hover:text-white text-sm transition-colors"
        >
          ✕ Close
        </button>
        <video
          src={videoUrl}
          controls
          autoPlay
          muted
          loop
          className="w-full rounded-xl bg-black"
          style={{ aspectRatio: '9/16' }}
        />
      </div>
    </div>
  )
}

export default function SuggestionCard({ suggestion, onStatusChange, onWhatToChangeEdit }: Props) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoLoading, setVideoLoading] = useState(false)
  const [showVideo, setShowVideo] = useState(false)
  const [videoModal, setVideoModal] = useState(false)
  const [showScores, setShowScores] = useState(true)

  // Editable what_to_change
  const [editingChange, setEditingChange] = useState(false)
  const [editedChange, setEditedChange] = useState(suggestion.what_to_change)
  const [savingChange, setSavingChange] = useState(false)

  // Dismiss with reason
  const [showDismissInput, setShowDismissInput] = useState(false)
  const [dismissReason, setDismissReason] = useState('')

  const post = suggestion.trends_posts

  const toggleScores = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setShowScores(v => !v)
  }, [])

  async function loadVideo() {
    if (videoUrl) { setShowVideo(true); return }
    setVideoLoading(true)
    const res = await fetch(`/api/posts/${post.id}`)
    const data = await res.json()
    setVideoUrl(data.post?.videoUrl ?? null)
    setVideoLoading(false)
    setShowVideo(true)
  }

  async function handleDownload() {
    let url = videoUrl
    if (!url) {
      setVideoLoading(true)
      const res = await fetch(`/api/posts/${post.id}`)
      const data = await res.json()
      url = data.post?.videoUrl ?? null
      setVideoUrl(url)
      setVideoLoading(false)
    }
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = `${post.creator_username}-${post.id}.mp4`
    a.target = '_blank'
    a.click()
  }

  async function handleSaveChange() {
    setSavingChange(true)
    await onWhatToChangeEdit(suggestion.id, editedChange)
    setSavingChange(false)
    setEditingChange(false)
  }

  function handleDismissConfirm() {
    onStatusChange(suggestion.id, 'dismissed', dismissReason.trim() || undefined)
    setShowDismissInput(false)
    setDismissReason('')
  }

  return (
    <>
      {videoModal && videoUrl && (
        <VideoModal videoUrl={videoUrl} onClose={() => setVideoModal(false)} />
      )}

      <div className="bg-[#111] border border-[#1e1e1e] rounded-xl overflow-hidden">
        <div className="flex gap-3 p-4">
          {/* Thumbnail / Video */}
          <div className="flex-shrink-0 w-20 relative">
            {showVideo && videoUrl ? (
              <div className="relative">
                <video
                  src={videoUrl}
                  controls
                  autoPlay
                  muted
                  loop
                  className="w-20 rounded-lg bg-black cursor-pointer"
                  style={{ aspectRatio: '9/16' }}
                  onClick={() => setVideoModal(true)}
                  title="Click to expand"
                />
                <button
                  onClick={() => setVideoModal(true)}
                  className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[10px] bg-black/70 text-white px-1.5 py-0.5 rounded transition-opacity hover:bg-black/90"
                >
                  ⛶
                </button>
              </div>
            ) : (
              <div
                className="w-20 h-28 rounded-lg overflow-hidden bg-[#0a0a0a] relative cursor-pointer group"
                onClick={loadVideo}
              >
                {post.thumbnail_r2_key ? (
                  <img
                    src={`/api/thumb/${post.id}`}
                    alt=""
                    className="w-full h-full object-cover blur-xl scale-110 group-hover:blur-md transition-all duration-300"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[#333] text-xs">No img</div>
                )}
                <div className="absolute inset-0 flex items-center justify-center">
                  {videoLoading ? (
                    <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    <span className="text-white text-lg">▶</span>
                  )}
                </div>
              </div>
            )}
            {showVideo && (
              <button
                onClick={() => setShowVideo(false)}
                className="absolute -top-1 -right-1 w-5 h-5 bg-[#1a1a1a] border border-[#333] rounded-full text-[#888] hover:text-white text-xs flex items-center justify-center"
              >
                ×
              </button>
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex items-start justify-between gap-2">
              {/* Creator + actions row */}
              <div className="flex items-center gap-2 flex-wrap">
                <a
                  href={post.creator_fansly_url ?? `https://fansly.com/${post.creator_username}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-[#888] hover:text-white transition-colors"
                >
                  @{post.creator_username}
                </a>
                <span className="text-xs text-[#555]">❤️ {fmt(post.likes_current)}</span>
                <ScoreBadge total={suggestion.score_total} onClick={toggleScores} />
                <a
                  href={`https://fansly.com/post/${post.fansly_post_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-500/70 hover:text-blue-400 transition-colors"
                >
                  View post ↗
                </a>
                <button
                  onClick={handleDownload}
                  disabled={videoLoading}
                  className="text-xs text-[#555] hover:text-[#888] transition-colors disabled:opacity-50"
                  title="Download video"
                >
                  {videoLoading ? '...' : '↓ Download'}
                </button>
              </div>

              {/* Status buttons */}
              {suggestion.status === 'pending' && !showDismissInput && (
                <div className="flex gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => onStatusChange(suggestion.id, 'approved')}
                    className="text-xs bg-blue-500/15 text-blue-400 border border-blue-500/25 hover:bg-blue-500/25 px-2.5 py-1 rounded-lg transition-colors"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => setShowDismissInput(true)}
                    className="text-xs bg-[#1a1a1a] text-[#555] border border-[#2a2a2a] hover:text-[#888] px-2.5 py-1 rounded-lg transition-colors"
                  >
                    Skip
                  </button>
                </div>
              )}
              {suggestion.status === 'pending' && showDismissInput && (
                <div className="flex gap-1.5 items-center flex-shrink-0">
                  <input
                    autoFocus
                    value={dismissReason}
                    onChange={e => setDismissReason(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleDismissConfirm()
                      if (e.key === 'Escape') { setShowDismissInput(false); setDismissReason('') }
                    }}
                    placeholder="Why? (helps AI)"
                    className="w-36 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-2.5 py-1 text-xs text-white placeholder-[#444] focus:outline-none focus:border-[#555]"
                  />
                  <button
                    onClick={handleDismissConfirm}
                    className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:text-white px-2.5 py-1 rounded-lg transition-colors whitespace-nowrap"
                  >
                    Dismiss
                  </button>
                  <button
                    onClick={() => { setShowDismissInput(false); setDismissReason('') }}
                    className="text-xs text-[#444] hover:text-[#666] transition-colors"
                  >
                    ✕
                  </button>
                </div>
              )}
              {suggestion.status === 'approved' && (
                <div className="flex gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => onStatusChange(suggestion.id, 'done')}
                    className="text-xs bg-green-500/15 text-green-400 border border-green-500/25 hover:bg-green-500/25 px-2.5 py-1 rounded-lg transition-colors"
                  >
                    Done ✓
                  </button>
                  <button
                    onClick={() => onStatusChange(suggestion.id, 'pending')}
                    className="text-xs text-[#444] hover:text-[#666] transition-colors"
                  >
                    Undo
                  </button>
                </div>
              )}
              {suggestion.status === 'dismissed' && (
                <button
                  onClick={() => onStatusChange(suggestion.id, 'pending')}
                  className="text-xs text-[#444] hover:text-[#666] transition-colors flex-shrink-0"
                >
                  Undo
                </button>
              )}
            </div>


            {suggestion.status === 'dismissed' && suggestion.dismiss_reason && (
              <p className="text-xs text-[#555] italic">Dismissed: &ldquo;{suggestion.dismiss_reason}&rdquo;</p>
            )}

            <div className="space-y-1.5">
              <p className="text-xs text-white leading-relaxed">
                <span className="text-[#555]">Why: </span>{suggestion.reasoning}
              </p>
              <p className="text-xs text-[#666] italic">
                From: {suggestion.branding_section}
              </p>

              {/* Editable Change section */}
              {editingChange ? (
                <div className="space-y-1.5">
                  <p className="text-xs text-[#555]">Change:</p>
                  <textarea
                    value={editedChange}
                    onChange={e => setEditedChange(e.target.value)}
                    rows={3}
                    className="w-full bg-[#0a0a0a] border border-[#3a3a3a] rounded-lg px-3 py-2 text-xs text-white resize-none focus:outline-none focus:border-[#555] leading-relaxed"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleSaveChange}
                      disabled={savingChange}
                      className="text-xs bg-white text-black px-3 py-1 rounded-lg hover:bg-[#e5e5e5] disabled:opacity-50 transition-colors"
                    >
                      {savingChange ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      onClick={() => { setEditingChange(false); setEditedChange(suggestion.what_to_change) }}
                      className="text-xs text-[#444] hover:text-[#666] transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <p className="text-xs text-[#888] leading-relaxed flex-1">
                    <span className="text-[#555]">Change: </span>{editedChange}
                  </p>
                  <button
                    onClick={() => setEditingChange(true)}
                    className="text-[10px] text-[#555] hover:text-white border border-[#2a2a2a] hover:border-[#444] px-1.5 py-0.5 rounded transition-colors flex-shrink-0 mt-0.5"
                    title="Edit"
                  >
                    Edit
                  </button>
                </div>
              )}
            </div>

            {/* Score breakdown */}
            {showScores && suggestion.score_total !== null && (
              <div className="border border-[#1e1e1e] rounded-lg p-3 bg-[#0a0a0a]">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  {SCORE_DIMS.map(({ key, label }) => (
                    <div key={key} className="flex items-center gap-2">
                      <span className="text-xs text-[#555] w-24 shrink-0">{label}</span>
                      <ScoreBar value={suggestion[key] as number | null} />
                    </div>
                  ))}
                </div>
                <div className="mt-2 pt-2 border-t border-[#1e1e1e] flex items-center justify-between">
                  <span className="text-xs text-[#555]">Total</span>
                  <span className={`text-xs font-semibold ${
                    suggestion.score_total >= 60 ? 'text-green-400'
                    : suggestion.score_total >= 50 ? 'text-yellow-400'
                    : 'text-red-400'
                  }`}>{suggestion.score_total}/80</span>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </>
  )
}
