'use client'
import { useState, useCallback } from 'react'

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
  status: 'pending' | 'done' | 'dismissed'
  notes: string | null
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
  onStatusChange: (id: string, status: 'pending' | 'done' | 'dismissed') => void
  onNotesChange: (id: string, notes: string) => void
}

function fmt(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

export default function SuggestionCard({ suggestion, onStatusChange, onNotesChange }: Props) {
  const [editingNotes, setEditingNotes] = useState(false)
  const [notes, setNotes] = useState(suggestion.notes ?? '')
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoLoading, setVideoLoading] = useState(false)
  const [showVideo, setShowVideo] = useState(false)
  const [showScores, setShowScores] = useState(true)
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

  function handleNotesSave() {
    setEditingNotes(false)
    onNotesChange(suggestion.id, notes)
  }

  return (
    <div className="bg-[#111] border border-[#1e1e1e] rounded-xl overflow-hidden">
      <div className="flex gap-3 p-4">
        {/* Thumbnail / Video */}
        <div className="flex-shrink-0 w-20 relative">
          {showVideo && videoUrl ? (
            <video
              src={videoUrl}
              controls
              autoPlay
              muted
              loop
              className="w-20 rounded-lg bg-black"
              style={{ aspectRatio: '9/16' }}
            />
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
            {suggestion.status === 'pending' && (
              <div className="flex gap-1.5 flex-shrink-0">
                <button
                  onClick={() => onStatusChange(suggestion.id, 'done')}
                  className="text-xs bg-green-500/15 text-green-400 border border-green-500/25 hover:bg-green-500/25 px-2.5 py-1 rounded-lg transition-colors"
                >
                  Done
                </button>
                <button
                  onClick={() => onStatusChange(suggestion.id, 'dismissed')}
                  className="text-xs bg-[#1a1a1a] text-[#555] border border-[#2a2a2a] hover:text-[#888] px-2.5 py-1 rounded-lg transition-colors"
                >
                  Skip
                </button>
              </div>
            )}
            {suggestion.status !== 'pending' && (
              <button
                onClick={() => onStatusChange(suggestion.id, 'pending')}
                className="text-xs text-[#444] hover:text-[#666] transition-colors flex-shrink-0"
              >
                Undo
              </button>
            )}
          </div>

          <div className="space-y-1.5">
            <p className="text-xs text-white leading-relaxed">
              <span className="text-[#555]">Why: </span>{suggestion.reasoning}
            </p>
            <p className="text-xs text-[#666] italic">
              From: {suggestion.branding_section}
            </p>
            <p className="text-xs text-[#888] leading-relaxed">
              <span className="text-[#555]">Change: </span>{suggestion.what_to_change}
            </p>
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

          {/* Notes */}
          {editingNotes ? (
            <div className="flex gap-2 items-end">
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Add a note..."
                rows={2}
                className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-xs text-white placeholder-[#444] resize-none focus:outline-none focus:border-[#444]"
              />
              <button
                onClick={handleNotesSave}
                className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:text-white px-3 py-2 rounded-lg transition-colors"
              >
                Save
              </button>
            </div>
          ) : (
            <button
              onClick={() => setEditingNotes(true)}
              className="text-xs text-[#444] hover:text-[#666] transition-colors"
            >
              {notes ? `"${notes.slice(0, 60)}${notes.length > 60 ? '...' : ''}"` : '+ Add note'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
