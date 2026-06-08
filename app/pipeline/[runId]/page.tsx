'use client'
import { useState, useEffect, useCallback, use } from 'react'
import Link from 'next/link'

interface QualityScores {
  hook_power?: number
  replayability?: number
  retention?: number
  payoff?: number
  video_quality?: number
  ai_quality?: number
  total?: number
}

interface SourcePost {
  post_db_id?: string | null
  thumbnail_r2_key: string | null
  video_r2_key: string | null
  creator_username: string
  likes_current: number
}

interface VideoSlot {
  id: string
  slot: number
  slot_number: number
  status: string
  overlay_text?: string | null
  caption?: string | null
  content_format?: string | null
  error_note?: string | null
  concept?: string | null
  what_to_change?: string | null
  user_action?: string | null
  dismiss_reason?: string | null
  source_post_id?: string | null
  source_post?: SourcePost | null
  brief?: {
    quality_scores?: QualityScores
  } | null
  variants?: unknown[]
}

interface RunDetail {
  id: string
  handle: string
  status: string
  created_at: string
  slots: VideoSlot[]
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { color: string; dot: string }> = {
    ready:      { color: 'text-green-400',  dot: 'bg-green-400' },
    approved:   { color: 'text-emerald-400', dot: 'bg-emerald-400' },
    generating: { color: 'text-blue-400 animate-pulse', dot: 'bg-blue-400' },
    processing: { color: 'text-blue-400 animate-pulse', dot: 'bg-blue-400' },
    queued:     { color: 'text-yellow-400', dot: 'bg-yellow-400' },
    rejected:   { color: 'text-red-400',   dot: 'bg-red-400' },
    dismissed:  { color: 'text-[#555]',    dot: 'bg-[#555]' },
    pending:    { color: 'text-[#555]',    dot: 'bg-[#555]' },
  }
  const { color, dot } = map[status] ?? { color: 'text-[#555]', dot: 'bg-[#555]' }
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {status}
    </span>
  )
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function SourceVideoPanel({ slot, runHandle }: { slot: VideoSlot; runHandle: string }) {
  const [showSource, setShowSource] = useState(false)
  const sourcePost = slot.source_post

  if (!sourcePost && !slot.source_post_id) return null

  // Use the existing /api/thumb/[id] route which serves by post DB UUID
  const thumbUrl = sourcePost?.post_db_id
    ? `/api/thumb/${sourcePost.post_db_id}`
    : null

  const sourceVideoUrl = sourcePost?.video_r2_key
    ? `/api/r2proxy?key=${encodeURIComponent(sourcePost.video_r2_key)}`
    : null

  return (
    <div className="border border-[#2a2a2a] rounded-xl overflow-hidden bg-[#0d0d0d]">
      <button
        onClick={() => setShowSource(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[#141414] transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[#555] uppercase tracking-wider">Reference</span>
          {sourcePost && (
            <span className="text-xs text-[#666]">@{sourcePost.creator_username} · {sourcePost.likes_current.toLocaleString()} likes</span>
          )}
        </div>
        <span className="text-[#444] text-xs">{showSource ? '▲' : '▼'}</span>
      </button>

      {showSource && (
        <div className="px-4 pb-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {/* Source thumbnail */}
            <div className="space-y-1">
              <p className="text-[10px] text-[#444] uppercase tracking-wider">Original</p>
              {thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumbUrl} alt="source" className="w-full aspect-[9/16] object-cover rounded-lg" />
              ) : sourceVideoUrl ? (
                <video src={sourceVideoUrl} className="w-full aspect-[9/16] object-cover rounded-lg" muted controls />
              ) : (
                <div className="w-full aspect-[9/16] bg-[#1a1a1a] rounded-lg flex items-center justify-center">
                  <span className="text-[#333] text-xs">No preview</span>
                </div>
              )}
            </div>

            {/* What was copied / changed */}
            <div className="space-y-3 flex flex-col justify-start pt-1">
              {slot.concept && (
                <div>
                  <p className="text-[10px] text-[#444] uppercase tracking-wider mb-1">What we&apos;re making</p>
                  <p className="text-xs text-[#aaa] leading-relaxed">{slot.concept}</p>
                </div>
              )}
              {slot.what_to_change && (
                <div>
                  <p className="text-[10px] text-[#444] uppercase tracking-wider mb-1">Our twist</p>
                  <p className="text-xs text-[#aaa] leading-relaxed">{slot.what_to_change}</p>
                </div>
              )}
              {slot.content_format && (
                <div>
                  <p className="text-[10px] text-[#444] uppercase tracking-wider mb-1">Format</p>
                  <span className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-violet-400 px-2 py-0.5 rounded-full">
                    {slot.content_format}
                  </span>
                </div>
              )}
              {slot.overlay_text && (
                <div>
                  <p className="text-[10px] text-[#444] uppercase tracking-wider mb-1">Text overlay</p>
                  <p className="text-xs text-white font-medium">&ldquo;{slot.overlay_text}&rdquo;</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function FeedbackPanel({
  slot,
  onAction,
}: {
  slot: VideoSlot
  onAction: (updated: Partial<VideoSlot>) => void
}) {
  const [mode, setMode] = useState<'idle' | 'reprocess' | 'dismiss'>('idle')
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const currentAction = slot.user_action

  async function handleApprove() {
    setLoading(true)
    await fetch(`/api/pipeline/videos/${slot.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_action: 'approved' }),
    })
    setLoading(false)
    onAction({ user_action: 'approved' })
    setMsg('Approved')
    setTimeout(() => setMsg(null), 2000)
  }

  async function handleDismiss() {
    if (!text.trim()) return
    setLoading(true)
    await fetch(`/api/pipeline/videos/${slot.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_action: 'dismissed', dismiss_reason: text.trim() }),
    })
    setLoading(false)
    onAction({ user_action: 'dismissed', dismiss_reason: text.trim() })
    setMode('idle')
    setText('')
    setMsg('Dismissed — feedback saved for next generation')
    setTimeout(() => setMsg(null), 3000)
  }

  async function handleReprocess() {
    setLoading(true)
    const endpoint = text.trim()
      ? `/api/pipeline/videos/${slot.id}/regenerate`
      : `/api/pipeline/videos/${slot.id}/reprocess`

    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(text.trim() ? { feedback: text.trim() } : {}),
    })
    setLoading(false)
    onAction({ user_action: null, status: 'generating' as VideoSlot['status'] })
    setMode('idle')
    setText('')
    setMsg(text.trim() ? 'Re-generating with feedback...' : 'Re-processing...')
    setTimeout(() => setMsg(null), 3000)
  }

  if (slot.status === 'rejected') return null

  return (
    <div className="space-y-2">
      {currentAction === 'approved' && (
        <div className="flex items-center gap-2 text-emerald-400">
          <span className="text-xs">✓ Approved</span>
          <button
            onClick={() => fetch(`/api/pipeline/videos/${slot.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ user_action: null }),
            }).then(() => onAction({ user_action: null }))}
            className="text-[10px] text-[#444] hover:text-[#888] transition-colors"
          >
            undo
          </button>
        </div>
      )}
      {currentAction === 'dismissed' && (
        <div className="space-y-1">
          <span className="text-xs text-[#555]">Dismissed</span>
          {slot.dismiss_reason && (
            <p className="text-xs text-[#444] italic">&ldquo;{slot.dismiss_reason}&rdquo;</p>
          )}
        </div>
      )}

      {currentAction !== 'approved' && currentAction !== 'dismissed' && mode === 'idle' && (
        <div className="flex items-center gap-2">
          <button
            onClick={handleApprove}
            disabled={loading}
            className="text-xs bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 px-3 py-1.5 rounded-lg disabled:opacity-50 transition-colors"
          >
            ✓ Approve
          </button>
          <button
            onClick={() => setMode('reprocess')}
            className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:text-white px-3 py-1.5 rounded-lg transition-colors"
          >
            ↺ Re-generate
          </button>
          <button
            onClick={() => setMode('dismiss')}
            className="text-xs text-[#444] hover:text-red-400 border border-[#1a1a1a] px-3 py-1.5 rounded-lg transition-colors"
          >
            ✕ Dismiss
          </button>
        </div>
      )}

      {mode === 'reprocess' && (
        <div className="space-y-2">
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Tell me what to fix (optional). Leave blank to just re-process with same brief."
            rows={3}
            autoFocus
            className="w-full bg-[#0a0a0a] border border-[#333] rounded-lg px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-violet-500 resize-none"
          />
          <div className="flex gap-2">
            <button
              onClick={handleReprocess}
              disabled={loading}
              className="text-xs bg-white text-black px-3 py-1.5 rounded-lg hover:bg-[#e5e5e5] disabled:opacity-50 transition-colors"
            >
              {loading ? 'Starting...' : text.trim() ? 'Re-generate with feedback' : 'Re-process'}
            </button>
            <button
              onClick={() => { setMode('idle'); setText('') }}
              className="text-xs text-[#555] hover:text-white transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === 'dismiss' && (
        <div className="space-y-2">
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Why is this wrong? (required — used to improve future suggestions)"
            rows={2}
            autoFocus
            className="w-full bg-[#0a0a0a] border border-[#333] rounded-lg px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-red-500 resize-none"
          />
          <div className="flex gap-2">
            <button
              onClick={handleDismiss}
              disabled={loading || !text.trim()}
              className="text-xs bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 px-3 py-1.5 rounded-lg disabled:opacity-50 transition-colors"
            >
              {loading ? 'Saving...' : 'Dismiss'}
            </button>
            <button
              onClick={() => { setMode('idle'); setText('') }}
              className="text-xs text-[#555] hover:text-white transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {msg && <p className="text-xs text-[#555]">{msg}</p>}
    </div>
  )
}

function InlineEdit({
  label,
  value: initialValue,
  onSave,
  rows = 2,
}: {
  label: string
  value: string | null | undefined
  onSave: (val: string) => Promise<void>
  rows?: number
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(initialValue ?? '')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    await onSave(value)
    setSaving(false)
    setEditing(false)
  }

  if (!editing) {
    return (
      <div className="group flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[10px] text-[#444] uppercase tracking-wider mb-1">{label}</p>
          <p className="text-sm text-[#ccc] whitespace-pre-wrap break-words">
            {value || <span className="text-[#333] italic">—</span>}
          </p>
        </div>
        <button
          onClick={() => setEditing(true)}
          className="opacity-0 group-hover:opacity-100 text-[#333] hover:text-white transition-all mt-5 shrink-0 text-xs"
          title="Edit"
        >
          ✏
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-[10px] text-[#444] uppercase tracking-wider">{label}</p>
      <textarea
        value={value}
        onChange={e => setValue(e.target.value)}
        rows={rows}
        autoFocus
        className="w-full bg-[#0a0a0a] border border-[#333] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500 resize-none"
      />
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="text-xs bg-white text-black px-3 py-1.5 rounded-lg hover:bg-[#e5e5e5] disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={() => { setEditing(false); setValue(initialValue ?? '') }}
          className="text-xs text-[#555] hover:text-white transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function SlotCard({ slot, runHandle, onUpdate }: { slot: VideoSlot; runHandle: string; onUpdate: (updated: Partial<VideoSlot>) => void }) {
  const scores = slot.brief?.quality_scores
  const scoreKeys: (keyof QualityScores)[] = ['hook_power', 'replayability', 'retention', 'payoff', 'video_quality', 'ai_quality']

  function scoreColor(s: number) {
    if (s >= 8) return 'text-green-400'
    if (s >= 5) return 'text-yellow-400'
    return 'text-red-400'
  }

  async function handleSaveField(field: 'overlay_text' | 'caption', val: string) {
    const res = await fetch(`/api/pipeline/videos/${slot.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: val }),
    })
    if (res.ok) onUpdate({ [field]: val })
  }

  return (
    <div className={`bg-[#111] border rounded-xl overflow-hidden transition-colors ${
      slot.user_action === 'approved' ? 'border-emerald-500/30' :
      slot.user_action === 'dismissed' ? 'border-[#1a1a1a] opacity-60' :
      'border-[#1a1a1a]'
    }`}>
      {/* Slot header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1a1a1a]">
        <span className="text-xs text-[#555]">Slot {slot.slot_number ?? slot.slot}</span>
        <StatusBadge status={slot.user_action === 'approved' ? 'approved' : slot.status} />
      </div>

      <div className="p-4 space-y-4">
        {/* Source reference panel — always shown when available */}
        <SourceVideoPanel slot={slot} runHandle={runHandle} />

        {slot.status === 'ready' && (
          <>
            {/* Generated video */}
            <video
              src={`/api/pipeline/videos/${slot.id}/download`}
              controls
              className="w-full rounded-lg bg-black aspect-[9/16] object-contain"
            />

            {/* Quality scores */}
            {scores && (
              <div className="grid grid-cols-3 gap-2">
                {scoreKeys.map(key => {
                  const val = scores[key]
                  if (val == null) return null
                  return (
                    <div key={key} className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-lg p-2 text-center">
                      <p className="text-[10px] text-[#333] truncate">{key.replace(/_/g, ' ')}</p>
                      <p className={`text-sm font-semibold mt-0.5 ${scoreColor(val)}`}>{val}</p>
                    </div>
                  )
                })}
                {scores.total != null && (
                  <div className="bg-[#0a0a0a] border border-violet-500/20 rounded-lg p-2 text-center">
                    <p className="text-[10px] text-[#333]">total /90</p>
                    <p className={`text-sm font-semibold mt-0.5 ${scoreColor(scores.total / 9)}`}>{scores.total}</p>
                  </div>
                )}
              </div>
            )}

            {/* Editable fields */}
            <InlineEdit label="Overlay Text" value={slot.overlay_text} onSave={v => handleSaveField('overlay_text', v)} rows={1} />
            <InlineEdit label="Caption" value={slot.caption} onSave={v => handleSaveField('caption', v)} rows={3} />

            {/* Download */}
            <button
              onClick={() => window.open(`/api/pipeline/videos/${slot.id}/download`, '_blank')}
              className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:text-white px-3 py-1.5 rounded-lg transition-colors"
            >
              Download
            </button>

            {/* Feedback: Approve / Re-generate / Dismiss */}
            <div className="border-t border-[#1a1a1a] pt-3">
              <FeedbackPanel slot={slot} onAction={onUpdate} />
            </div>
          </>
        )}

        {slot.status === 'rejected' && (
          <div className="py-4 space-y-2">
            <p className="text-xs text-red-400 font-medium">Generation failed</p>
            {slot.error_note && (
              <p className="text-xs text-[#555] font-mono bg-[#0a0a0a] border border-[#1a1a1a] rounded-lg p-3">
                {slot.error_note}
              </p>
            )}
            <button
              onClick={async () => {
                await fetch(`/api/pipeline/videos/${slot.id}/reprocess`, { method: 'POST' })
                onUpdate({ status: 'generating' })
              }}
              className="text-xs text-[#555] hover:text-white border border-[#1e1e1e] px-3 py-1.5 rounded-lg transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {['pending', 'generating', 'processing', 'queued'].includes(slot.status) && (
          <div className="flex flex-col items-center justify-center py-8 gap-3">
            <div className="w-5 h-5 border-2 border-[#333] border-t-blue-400 rounded-full animate-spin" />
            <p className="text-xs text-[#555]">
              {slot.status === 'pending' ? 'Waiting...' : 'Generating...'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

export default function RunReviewPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params)
  const [run, setRun] = useState<RunDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [downloadingAll, setDownloadingAll] = useState(false)

  const fetchRun = useCallback(async () => {
    const res = await fetch(`/api/pipeline/runs/${runId}`)
    if (res.ok) {
      const data = await res.json()
      setRun({ ...data.run, slots: data.videos ?? [] })
    }
    setLoading(false)
  }, [runId])

  useEffect(() => { fetchRun() }, [fetchRun])

  useEffect(() => {
    if (!run) return
    const active = (run.slots ?? []).some(s =>
      ['pending', 'generating', 'processing', 'queued'].includes(s.status)
    )
    const runActive = ['queued', 'generating', 'processing'].includes(run.status)
    if (!active && !runActive) return
    const id = setInterval(fetchRun, 10_000)
    return () => clearInterval(id)
  }, [run, fetchRun])

  function handleSlotUpdate(slotId: string, updated: Partial<VideoSlot>) {
    setRun(prev => {
      if (!prev) return prev
      return { ...prev, slots: prev.slots.map(s => s.id === slotId ? { ...s, ...updated } : s) }
    })
  }

  async function handleDownloadAll() {
    if (!run) return
    setDownloadingAll(true)
    const ready = run.slots.filter(s => s.status === 'ready' && s.user_action !== 'dismissed')
    for (const slot of ready) {
      window.open(`/api/pipeline/videos/${slot.id}/download`, '_blank')
      await new Promise(r => setTimeout(r, 300))
    }
    setDownloadingAll(false)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-[#333] border-t-white rounded-full animate-spin" />
      </div>
    )
  }

  if (!run) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center text-[#555]">
        <p className="text-sm">Run not found</p>
      </div>
    )
  }

  const readyCount = run.slots.filter(s => s.status === 'ready').length
  const approvedCount = run.slots.filter(s => s.user_action === 'approved').length

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <nav className="bg-[#0f0f0f] border-b border-[#1e1e1e] px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <h1 className="text-sm font-bold text-white">FanslyTrends</h1>
        <div className="flex gap-4 text-xs text-[#666]">
          <Link href="/" className="hover:text-white transition-colors">Feed</Link>
          <Link href="/ideas" className="hover:text-white transition-colors">Ideas</Link>
          <Link href="/models" className="hover:text-white transition-colors">Models</Link>
          <Link href="/pipeline" className="text-white">Pipeline</Link>
        </div>
      </nav>

      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Link href="/pipeline" className="text-xs text-[#555] hover:text-white transition-colors inline-flex items-center gap-1">
              ← Back to Pipeline
            </Link>
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold">@{run.handle} — Run review</h2>
              <StatusBadge status={run.status} />
            </div>
            <p className="text-xs text-[#555]">
              {timeAgo(run.created_at)} &middot; {readyCount}/{run.slots.length} ready
              {approvedCount > 0 && <span className="text-emerald-400"> · {approvedCount} approved</span>}
            </p>
          </div>
          {readyCount > 0 && (
            <button
              onClick={handleDownloadAll}
              disabled={downloadingAll}
              className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:text-white px-4 py-2 rounded-lg disabled:opacity-50 transition-colors shrink-0"
            >
              {downloadingAll ? 'Opening...' : `Download All (${readyCount})`}
            </button>
          )}
        </div>

        {/* Slot grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {run.slots.map(slot => (
            <SlotCard
              key={slot.id}
              slot={slot}
              runHandle={run.handle}
              onUpdate={updated => handleSlotUpdate(slot.id, updated)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
