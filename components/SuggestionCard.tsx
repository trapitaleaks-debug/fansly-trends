'use client'
import { useState, useCallback, useEffect, useRef } from 'react'

interface Post {
  id: string
  fansly_post_id: string
  creator_username: string
  creator_fansly_url: string | null
  likes_current: number
  thumbnail_r2_key: string | null
  hashtags: string[]
}

export interface Suggestion {
  id: string
  status: 'pending' | 'done' | 'approved' | 'dismissed'
  notes: string | null
  dismiss_reason: string | null
  generated_at: string
  footage_type: 'ai' | 'own' | null
  own_footage_r2_key: string | null
  own_footage_label: string | null
  text_mode: 'original' | 'none' | 'custom' | null
  custom_text: string | null
  trends_posts: Post
}

interface OwnFootage {
  id: string
  r2_key: string
  label: string | null
}

interface Props {
  suggestion: Suggestion
  username: string
  onStatusChange: (id: string, status: 'pending' | 'done' | 'approved' | 'dismissed', dismissReason?: string) => void
  onFieldsUpdate: (id: string, fields: Partial<Suggestion>) => void
}

function fmt(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

// Full-screen hyperframe video viewer
function VideoHyperframe({ videoUrl, title, onClose }: {
  videoUrl: string
  title?: string
  onClose: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      if (e.key === ' ') { e.preventDefault(); videoRef.current?.paused ? videoRef.current?.play() : videoRef.current?.pause() }
      if (e.key === 'ArrowRight') { if (videoRef.current) videoRef.current.currentTime += 2 }
      if (e.key === 'ArrowLeft') { if (videoRef.current) videoRef.current.currentTime -= 2 }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="relative flex gap-6 max-h-screen p-6 items-center"
        onClick={e => e.stopPropagation()}
      >
        {/* Video */}
        <div className="relative">
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            autoPlay
            loop
            className="rounded-2xl bg-black shadow-2xl"
            style={{ maxHeight: 'calc(100vh - 80px)', maxWidth: '400px', aspectRatio: '9/16' }}
          />
        </div>

        {/* Info panel */}
        {title && (
          <div className="max-w-xs space-y-4 text-white">
            <div>
              <p className="text-[10px] text-[#555] uppercase tracking-widest mb-1">Creator</p>
              <p className="text-sm font-medium">{title}</p>
            </div>
            <p className="text-[10px] text-[#444] mt-4">
              Space: play/pause · ← →: seek 2s · Esc: close
            </p>
          </div>
        )}

        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-2 right-2 w-8 h-8 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center text-white/60 hover:text-white transition-colors"
        >
          ✕
        </button>
      </div>
    </div>
  )
}

type ProductionSettings = {
  footage_type: 'ai' | 'own'
  own_footage_r2_key: string | null
  own_footage_label: string | null
  text_mode: 'original' | 'none' | 'custom'
  custom_text: string | null
}

// Inline approval form shown when approving or editing approved settings
function ProductionForm({
  initial,
  ownFootageOptions,
  loadingFootage,
  onConfirm,
  onCancel,
  confirmLabel,
}: {
  initial: ProductionSettings
  ownFootageOptions: OwnFootage[]
  loadingFootage: boolean
  onConfirm: (data: ProductionSettings) => void
  onCancel: () => void
  confirmLabel: string
}) {
  const [footageType, setFootageType] = useState<'ai' | 'own'>(initial.footage_type || 'ai')
  const [ownFootageKey, setOwnFootageKey] = useState(initial.own_footage_r2_key || '')
  const [ownFootageLabel, setOwnFootageLabel] = useState(initial.own_footage_label || '')
  const [textMode, setTextMode] = useState<'original' | 'none' | 'custom'>(initial.text_mode || 'original')
  const [customText, setCustomText] = useState(initial.custom_text || '')

  function handleConfirm() {
    onConfirm({
      footage_type: footageType,
      own_footage_r2_key: footageType === 'own' ? ownFootageKey || null : null,
      own_footage_label: footageType === 'own' ? ownFootageLabel || null : null,
      text_mode: textMode,
      custom_text: textMode === 'custom' ? customText || null : null,
    })
  }

  return (
    <div className="border border-[#2a2a2a] rounded-xl p-4 bg-[#0d0d0d] space-y-4">
      {/* Footage */}
      <div className="space-y-2">
        <p className="text-[10px] text-[#555] uppercase tracking-widest">Footage</p>
        <div className="flex gap-2">
          <button
            onClick={() => setFootageType('ai')}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${footageType === 'ai' ? 'bg-violet-500/20 border-violet-500/40 text-violet-300' : 'bg-[#1a1a1a] border-[#2a2a2a] text-[#666] hover:text-[#888]'}`}
          >
            AI Generated
          </button>
          <button
            onClick={() => setFootageType('own')}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${footageType === 'own' ? 'bg-violet-500/20 border-violet-500/40 text-violet-300' : 'bg-[#1a1a1a] border-[#2a2a2a] text-[#666] hover:text-[#888]'}`}
          >
            Own Footage
          </button>
        </div>

        {footageType === 'own' && (
          <div className="ml-0">
            {loadingFootage ? (
              <p className="text-xs text-[#444]">Loading footage...</p>
            ) : ownFootageOptions.length === 0 ? (
              <p className="text-xs text-[#444]">No footage uploaded yet. Upload via the Pipeline page.</p>
            ) : (
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {ownFootageOptions.map(f => (
                  <button
                    key={f.id}
                    onClick={() => { setOwnFootageKey(f.r2_key); setOwnFootageLabel(f.label ?? f.r2_key) }}
                    className={`w-full text-left text-xs px-3 py-2 rounded-lg border transition-colors ${ownFootageKey === f.r2_key ? 'bg-violet-500/20 border-violet-500/40 text-violet-300' : 'bg-[#1a1a1a] border-[#2a2a2a] text-[#888] hover:text-white hover:border-[#3a3a3a]'}`}
                  >
                    {f.label || f.r2_key.split('/').pop()}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Text on screen */}
      <div className="space-y-2">
        <p className="text-[10px] text-[#555] uppercase tracking-widest">Text on Screen</p>
        <div className="flex gap-2 flex-wrap">
          {(['original', 'none', 'custom'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => setTextMode(mode)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors capitalize ${textMode === mode ? 'bg-violet-500/20 border-violet-500/40 text-violet-300' : 'bg-[#1a1a1a] border-[#2a2a2a] text-[#666] hover:text-[#888]'}`}
            >
              {mode === 'original' ? 'Original' : mode === 'none' ? 'None' : 'Custom'}
            </button>
          ))}
        </div>
        {textMode === 'custom' && (
          <input
            autoFocus
            value={customText}
            onChange={e => setCustomText(e.target.value)}
            placeholder="Enter custom text..."
            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-xs text-white placeholder-[#444] focus:outline-none focus:border-violet-500"
          />
        )}
      </div>

      <div className="flex gap-2 pt-1">
        <button
          onClick={handleConfirm}
          disabled={footageType === 'own' && !ownFootageKey}
          className="text-xs bg-white text-black font-medium px-4 py-1.5 rounded-lg hover:bg-[#e5e5e5] disabled:opacity-40 transition-colors"
        >
          {confirmLabel}
        </button>
        <button
          onClick={onCancel}
          className="text-xs text-[#444] hover:text-[#666] transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

export default function SuggestionCard({ suggestion, username, onStatusChange, onFieldsUpdate }: Props) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoLoading, setVideoLoading] = useState(false)
  const [videoHyperframe, setVideoHyperframe] = useState(false)

  // Notes
  const [notes, setNotes] = useState(suggestion.notes ?? '')
  const [savingNotes, setSavingNotes] = useState(false)

  // Dismiss flow
  const [showDismissInput, setShowDismissInput] = useState(false)
  const [dismissReason, setDismissReason] = useState('')

  // Approval / production settings form
  const [showApprovalForm, setShowApprovalForm] = useState(false)
  const [showEditSettings, setShowEditSettings] = useState(false)
  const [ownFootageOptions, setOwnFootageOptions] = useState<OwnFootage[]>([])
  const [loadingFootage, setLoadingFootage] = useState(false)
  const footageLoaded = useRef(false)

  const post = suggestion.trends_posts

  async function loadVideo() {
    if (videoUrl) { setVideoHyperframe(true); return }
    setVideoLoading(true)
    const res = await fetch(`/api/posts/${post.id}`)
    const data = await res.json()
    setVideoUrl(data.post?.videoUrl ?? null)
    setVideoLoading(false)
    setVideoHyperframe(true)
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

  async function loadFootage() {
    if (footageLoaded.current) return
    footageLoaded.current = true
    setLoadingFootage(true)
    const res = await fetch(`/api/models/${username}/own-footage`)
    const data = await res.json()
    setOwnFootageOptions(data.footage ?? [])
    setLoadingFootage(false)
  }

  async function saveNotes(value: string) {
    setSavingNotes(true)
    await fetch(`/api/models/${username}/suggestions/${suggestion.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: value }),
    })
    setSavingNotes(false)
    onFieldsUpdate(suggestion.id, { notes: value })
  }

  function handleDismissConfirm() {
    onStatusChange(suggestion.id, 'dismissed', dismissReason.trim() || undefined)
    setShowDismissInput(false)
    setDismissReason('')
  }

  const initialProductionSettings = useCallback((): ProductionSettings => ({
    footage_type: suggestion.footage_type ?? 'ai',
    own_footage_r2_key: suggestion.own_footage_r2_key,
    own_footage_label: suggestion.own_footage_label,
    text_mode: suggestion.text_mode ?? 'original',
    custom_text: suggestion.custom_text,
  }), [suggestion])

  async function handleApproveConfirm(data: ProductionSettings) {
    await fetch(`/api/models/${username}/suggestions/${suggestion.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved', ...data }),
    })
    onFieldsUpdate(suggestion.id, { status: 'approved', ...data } as Partial<Suggestion>)
    onStatusChange(suggestion.id, 'approved')
    setShowApprovalForm(false)
  }

  async function handleSettingsUpdate(data: ProductionSettings) {
    await fetch(`/api/models/${username}/suggestions/${suggestion.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    onFieldsUpdate(suggestion.id, data as Partial<Suggestion>)
    setShowEditSettings(false)
  }

  const productionLabel = useCallback(() => {
    const f = suggestion.footage_type ?? 'ai'
    const t = suggestion.text_mode ?? 'original'
    const parts: string[] = []
    parts.push(f === 'own' ? (suggestion.own_footage_label ?? 'Own Footage') : 'AI')
    parts.push(t === 'none' ? 'No text' : t === 'custom' ? `"${suggestion.custom_text ?? ''}"` : 'Original text')
    return parts.join(' · ')
  }, [suggestion])

  return (
    <>
      {videoHyperframe && videoUrl && (
        <VideoHyperframe
          videoUrl={videoUrl}
          title={`@${post.creator_username}`}
          onClose={() => setVideoHyperframe(false)}
        />
      )}

      <div className="bg-[#111] border border-[#1e1e1e] rounded-xl overflow-hidden">
        <div className="flex gap-3 p-4">
          {/* Thumbnail */}
          <div className="flex-shrink-0 w-20">
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
                  <span className="text-white text-lg drop-shadow">▶</span>
                )}
              </div>
              <div className="absolute bottom-1 inset-x-0 text-center">
                <span className="text-[9px] text-white/50 bg-black/50 px-1 rounded">open</span>
              </div>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0 space-y-2.5">
            {/* Top row */}
            <div className="flex items-start justify-between gap-2">
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
                <a
                  href={`https://fansly.com/post/${post.fansly_post_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-500/70 hover:text-blue-400 transition-colors"
                >
                  ↗
                </a>
                <button
                  onClick={handleDownload}
                  disabled={videoLoading}
                  className="text-xs text-[#555] hover:text-[#888] transition-colors disabled:opacity-50"
                >
                  {videoLoading ? '...' : '↓'}
                </button>
              </div>

              {/* Status buttons */}
              {suggestion.status === 'pending' && !showDismissInput && !showApprovalForm && (
                <div className="flex gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => { loadFootage(); setShowApprovalForm(true) }}
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
                    className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:text-white px-2.5 py-1 rounded-lg transition-colors"
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

              {suggestion.status === 'approved' && !showEditSettings && (
                <button
                  onClick={() => onStatusChange(suggestion.id, 'pending')}
                  className="text-xs text-[#444] hover:text-[#666] transition-colors flex-shrink-0"
                >
                  Undo
                </button>
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

            {/* Dismissed reason */}
            {suggestion.status === 'dismissed' && (
              <div className="rounded-lg border border-orange-500/25 bg-orange-500/8 px-3 py-2">
                <span className="text-[10px] font-semibold text-orange-400 uppercase tracking-wide">Skipped</span>
                {suggestion.dismiss_reason ? (
                  <p className="text-xs text-white/70 mt-1 leading-relaxed">{suggestion.dismiss_reason}</p>
                ) : (
                  <p className="text-xs text-white/30 mt-1 italic">No reason noted</p>
                )}
              </div>
            )}

            {/* Approval form (pending → approve) */}
            {showApprovalForm && suggestion.status === 'pending' && (
              <ProductionForm
                initial={initialProductionSettings()}
                ownFootageOptions={ownFootageOptions}
                loadingFootage={loadingFootage}
                onConfirm={handleApproveConfirm}
                onCancel={() => setShowApprovalForm(false)}
                confirmLabel="Confirm Approval"
              />
            )}

            {/* Approved: show production settings */}
            {suggestion.status === 'approved' && !showEditSettings && (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-2.5 py-1.5">
                  <span className="text-[10px] text-emerald-400">✓ Approved</span>
                  <span className="text-[#444] text-[10px]">·</span>
                  <span className="text-[10px] text-[#888]">{productionLabel()}</span>
                </div>
                <button
                  onClick={() => { loadFootage(); setShowEditSettings(true) }}
                  className="text-[10px] text-[#555] hover:text-white border border-[#2a2a2a] hover:border-[#444] px-2 py-1 rounded-lg transition-colors"
                >
                  Edit
                </button>
              </div>
            )}

            {/* Edit settings form (approved state) */}
            {showEditSettings && suggestion.status === 'approved' && (
              <ProductionForm
                initial={initialProductionSettings()}
                ownFootageOptions={ownFootageOptions}
                loadingFootage={loadingFootage}
                onConfirm={handleSettingsUpdate}
                onCancel={() => setShowEditSettings(false)}
                confirmLabel="Save Settings"
              />
            )}

            {/* Notes */}
            <div className="space-y-1">
              <p className="text-[10px] text-[#444] uppercase tracking-widest">Notes</p>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                onBlur={e => { if (e.target.value !== (suggestion.notes ?? '')) saveNotes(e.target.value) }}
                placeholder="Add notes..."
                rows={2}
                className="w-full bg-[#0a0a0a] border border-[#1a1a1a] focus:border-[#2a2a2a] rounded-lg px-2.5 py-2 text-xs text-white placeholder-[#333] focus:outline-none resize-none leading-relaxed"
              />
              {savingNotes && <p className="text-[10px] text-[#444]">Saving...</p>}
            </div>

          </div>
        </div>
      </div>
    </>
  )
}
