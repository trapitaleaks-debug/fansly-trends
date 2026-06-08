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

interface VideoVariant {
  id: string
  type: 'image' | 'video'
  r2_key: string
  signed_url?: string
}

interface VideoSlot {
  id: string
  slot_number: number
  status: 'pending' | 'generating' | 'processing' | 'ready' | 'failed'
  overlay_text?: string | null
  caption?: string | null
  content_format?: string | null
  error_note?: string | null
  selected_variant_id?: string | null
  brief?: {
    quality_scores?: QualityScores
  } | null
  variants?: VideoVariant[]
}

interface RunDetail {
  id: string
  handle: string
  status: string
  created_at: string
  slots: VideoSlot[]
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    ready: 'text-green-400',
    generating: 'text-blue-400 animate-pulse',
    processing: 'text-blue-400 animate-pulse',
    queued: 'text-yellow-400',
    failed: 'text-red-400',
    pending: 'text-[#555]',
  }
  const dots: Record<string, string> = {
    ready: 'bg-green-400',
    generating: 'bg-blue-400',
    processing: 'bg-blue-400',
    queued: 'bg-yellow-400',
    failed: 'bg-red-400',
    pending: 'bg-[#555]',
  }
  const cls = styles[status] ?? 'text-[#555]'
  const dot = dots[status] ?? 'bg-[#555]'
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {status}
    </span>
  )
}

function scoreColor(score: number) {
  if (score >= 8) return 'text-green-400'
  if (score >= 5) return 'text-yellow-400'
  return 'text-red-400'
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

function InlineEdit({
  label,
  value: initialValue,
  onSave,
  rows = 3,
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
          <p className="text-xs text-[#555] mb-1">{label}</p>
          <p className="text-sm text-[#ccc] whitespace-pre-wrap break-words">
            {value || <span className="text-[#444] italic">None</span>}
          </p>
        </div>
        <button
          onClick={() => setEditing(true)}
          className="opacity-0 group-hover:opacity-100 text-[#444] hover:text-white transition-all mt-5 shrink-0"
          title="Edit"
        >
          ✏
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-[#555]">{label}</p>
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

function SlotCard({ slot, onUpdate }: { slot: VideoSlot; onUpdate: (updated: Partial<VideoSlot>) => void }) {
  const [showVariants, setShowVariants] = useState(false)
  const [reprocessing, setReprocessing] = useState(false)
  const [reprocessMsg, setReprocessMsg] = useState<string | null>(null)
  const [selectedVariantId, setSelectedVariantId] = useState(slot.selected_variant_id ?? null)

  async function handleSaveField(field: 'overlay_text' | 'caption', val: string) {
    const res = await fetch(`/api/pipeline/videos/${slot.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: val }),
    })
    if (res.ok) onUpdate({ [field]: val })
  }

  async function handleReprocess() {
    setReprocessing(true)
    setReprocessMsg(null)
    const res = await fetch(`/api/pipeline/videos/${slot.id}/reprocess`, { method: 'POST' })
    setReprocessing(false)
    setReprocessMsg(res.ok ? 'Queued for reprocessing' : 'Failed to reprocess')
    setTimeout(() => setReprocessMsg(null), 3000)
  }

  async function handleSelectVariant(variantId: string) {
    const res = await fetch(`/api/pipeline/videos/${slot.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selected_variant_id: variantId }),
    })
    if (res.ok) {
      setSelectedVariantId(variantId)
      onUpdate({ selected_variant_id: variantId })
    }
  }

  const scores = slot.brief?.quality_scores
  const scoreKeys: (keyof QualityScores)[] = ['hook_power', 'replayability', 'retention', 'payoff', 'video_quality', 'ai_quality']

  return (
    <div className="bg-[#111] border border-[#1a1a1a] rounded-xl overflow-hidden">
      {/* Slot header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1a1a1a]">
        <span className="text-xs text-[#555]">Slot {slot.slot_number}</span>
        <div className="flex items-center gap-3">
          {slot.content_format && (
            <span className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-violet-400 px-2 py-0.5 rounded-full">
              {slot.content_format}
            </span>
          )}
          <StatusBadge status={slot.status} />
        </div>
      </div>

      <div className="p-4 space-y-4">
        {slot.status === 'ready' && (
          <>
            {/* Video player */}
            <video
              src={`/api/pipeline/videos/${slot.id}/download`}
              controls
              className="w-full rounded-lg bg-black aspect-[9/16] object-contain"
            />

            {/* Quality scores */}
            {scores && (
              <div className="space-y-2">
                <p className="text-xs text-[#555]">Quality Scores</p>
                <div className="grid grid-cols-3 gap-2">
                  {scoreKeys.map(key => {
                    const val = scores[key]
                    if (val == null) return null
                    return (
                      <div key={key} className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-lg p-2 text-center">
                        <p className="text-[10px] text-[#444] truncate">{key.replace(/_/g, ' ')}</p>
                        <p className={`text-sm font-semibold mt-0.5 ${scoreColor(val)}`}>{val}</p>
                      </div>
                    )
                  })}
                  {scores.total != null && (
                    <div className="bg-[#0a0a0a] border border-violet-500/20 rounded-lg p-2 text-center">
                      <p className="text-[10px] text-[#444]">total /90</p>
                      <p className={`text-sm font-semibold mt-0.5 ${scoreColor(scores.total / 9)}`}>{scores.total}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Editable fields */}
            <InlineEdit
              label="Overlay Text"
              value={slot.overlay_text}
              onSave={val => handleSaveField('overlay_text', val)}
            />
            <InlineEdit
              label="Caption"
              value={slot.caption}
              onSave={val => handleSaveField('caption', val)}
              rows={4}
            />

            {/* Actions */}
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={() => window.open(`/api/pipeline/videos/${slot.id}/download`, '_blank')}
                className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:text-white px-3 py-1.5 rounded-lg transition-colors"
              >
                Download
              </button>
              <button
                onClick={handleReprocess}
                disabled={reprocessing}
                className="text-xs text-[#555] hover:text-white border border-[#1e1e1e] px-3 py-1.5 rounded-lg disabled:opacity-50 transition-colors"
              >
                {reprocessing ? 'Processing...' : 'Re-process'}
              </button>
              {reprocessMsg && (
                <span className="text-xs text-[#555]">{reprocessMsg}</span>
              )}
            </div>

            {/* Variants */}
            {slot.variants && slot.variants.length > 0 && (
              <div className="border-t border-[#1a1a1a] pt-3 space-y-2">
                <button
                  onClick={() => setShowVariants(v => !v)}
                  className="text-xs text-[#555] hover:text-white transition-colors"
                >
                  {showVariants ? 'Hide variants' : `Show variants (${slot.variants.length})`}
                </button>
                {showVariants && (
                  <div className="grid grid-cols-3 gap-2">
                    {slot.variants.map(variant => (
                      <button
                        key={variant.id}
                        onClick={() => handleSelectVariant(variant.id)}
                        className={`relative rounded-lg overflow-hidden border-2 transition-colors ${
                          selectedVariantId === variant.id ? 'border-green-500' : 'border-transparent'
                        }`}
                        title={variant.type}
                      >
                        {variant.type === 'image' ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={variant.signed_url}
                            alt="variant"
                            className="w-full aspect-square object-cover"
                          />
                        ) : (
                          <video
                            src={variant.signed_url}
                            className="w-full aspect-[9/16] object-cover"
                            muted
                          />
                        )}
                        {selectedVariantId === variant.id && (
                          <span className="absolute top-1 right-1 bg-green-500 text-white text-[10px] px-1 rounded">✓</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {slot.status === 'failed' && (
          <div className="py-4 space-y-2">
            <p className="text-xs text-red-400 font-medium">Generation failed</p>
            {slot.error_note && (
              <p className="text-xs text-[#555] font-mono bg-[#0a0a0a] border border-[#1a1a1a] rounded-lg p-3">
                {slot.error_note}
              </p>
            )}
          </div>
        )}

        {(slot.status === 'pending' || slot.status === 'generating' || slot.status === 'processing') && (
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
      setRun(data.run)
    }
    setLoading(false)
  }, [runId])

  useEffect(() => {
    fetchRun()
  }, [fetchRun])

  // Auto-poll while any slot is still in progress
  useEffect(() => {
    if (!run) return
    const active = run.slots.some(s => s.status === 'pending' || s.status === 'generating' || s.status === 'processing')
    const runActive = run.status === 'queued' || run.status === 'generating' || run.status === 'processing'
    if (!active && !runActive) return
    const id = setInterval(fetchRun, 12_000)
    return () => clearInterval(id)
  }, [run, fetchRun])

  function handleSlotUpdate(slotId: string, updated: Partial<VideoSlot>) {
    setRun(prev => {
      if (!prev) return prev
      return {
        ...prev,
        slots: prev.slots.map(s => s.id === slotId ? { ...s, ...updated } : s),
      }
    })
  }

  async function handleDownloadAll() {
    if (!run) return
    setDownloadingAll(true)
    const readySlots = run.slots.filter(s => s.status === 'ready')
    for (const slot of readySlots) {
      window.open(`/api/pipeline/videos/${slot.id}/download`, '_blank')
      await new Promise(r => setTimeout(r, 300))
    }
    setDownloadingAll(false)
  }

  function timeAgoFmt(dateStr: string) { return timeAgo(dateStr) }

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

      <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Link
              href="/pipeline"
              className="text-xs text-[#555] hover:text-white transition-colors inline-flex items-center gap-1"
            >
              ← Back to Pipeline
            </Link>
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold">@{run.handle} — Run review</h2>
              <StatusBadge status={run.status} />
            </div>
            <p className="text-xs text-[#555]">
              {timeAgoFmt(run.created_at)} &middot; {readyCount}/{run.slots.length} ready
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
              onUpdate={updated => handleSlotUpdate(slot.id, updated)}
            />
          ))}
        </div>

      </div>
    </div>
  )
}
