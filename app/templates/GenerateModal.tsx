'use client'
import { useState, useEffect } from 'react'

interface Template {
  id: string
  text_template: string
}

interface Model {
  id: string
  fansly_username: string
}

interface Clip {
  id: string
  filename: string | null
  r2_key: string
  duration_seconds: number | null
  tags: string[]
}

interface ModelRow {
  username: string
  personalizedText: string
  status: 'idle' | 'loading' | 'done' | 'error'
  clips: Clip[]
  clipsLoading: boolean
  selectedClipId: string | null
  editingText: boolean
}

export default function GenerateModal({ template, onClose }: { template: Template; onClose: () => void }) {
  const [models, setModels] = useState<Model[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [rows, setRows] = useState<Record<string, ModelRow>>({})
  const [step, setStep] = useState<'pick' | 'review'>('pick')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    fetch('/api/models')
      .then(r => r.json())
      .then(({ models }) => setModels(models ?? []))
  }, [])

  function toggleModel(username: string) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(username) ? next.delete(username) : next.add(username)
      return next
    })
  }

  async function goToReview() {
    const usernames = [...selected]
    setStep('review')
    // Initialize rows and personalize all at once
    const initial: Record<string, ModelRow> = {}
    for (const u of usernames) {
      initial[u] = { username: u, personalizedText: '', status: 'loading', clips: [], clipsLoading: true, selectedClipId: null, editingText: false }
    }
    setRows(initial)

    await Promise.all(usernames.map(async username => {
      const [personRes, clipsRes] = await Promise.all([
        fetch(`/api/templates/${template.id}/personalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model_username: username }),
        }),
        fetch(`/api/clips?model=${username}`),
      ])

      const [personData, clipsData] = await Promise.all([personRes.json(), clipsRes.json()])

      setRows(prev => ({
        ...prev,
        [username]: {
          ...prev[username],
          personalizedText: personData.personalized_text ?? template.text_template,
          status: personData.personalized_text ? 'done' : 'error',
          clips: clipsData.clips ?? [],
          clipsLoading: false,
        },
      }))
    }))
  }

  function updateText(username: string, text: string) {
    setRows(prev => ({ ...prev, [username]: { ...prev[username], personalizedText: text } }))
  }

  function selectClip(username: string, clipId: string | null) {
    setRows(prev => ({ ...prev, [username]: { ...prev[username], selectedClipId: clipId } }))
  }

  async function submitJobs() {
    setSubmitting(true)
    const usernames = [...selected]
    await Promise.all(usernames.map(async username => {
      const row = rows[username]
      if (!row) return
      await fetch('/api/video-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          post_id: template.id,
          model_username: username,
          original_template: template.text_template,
          personalized_text: row.personalizedText || null,
          clip_id: row.selectedClipId || null,
        }),
      })
    }))
    setSubmitting(false)
    setDone(true)
  }

  return (
    <div className="fixed inset-0 bg-black/90 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div
        className="bg-[#111] border border-[#222] rounded-t-2xl sm:rounded-2xl w-full sm:max-w-2xl max-h-[92vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-[#1e1e1e] flex items-start justify-between gap-3 flex-shrink-0">
          <div>
            <p className="text-xs text-[#555] mb-1">{step === 'pick' ? 'Step 1 — Pick models' : 'Step 2 — Review & assign clips'}</p>
            <div className="bg-[#0a0a0a] rounded-lg px-3 py-2 text-sm text-white font-mono leading-snug">
              {template.text_template.split('\n').filter(Boolean).map((line, i) => (
                <span key={i} className="block">{line}</span>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="text-[#555] hover:text-white flex-shrink-0 text-lg">✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {done ? (
            <div className="text-center py-10">
              <p className="text-white text-base font-medium mb-1">{selected.size} job{selected.size !== 1 ? 's' : ''} queued</p>
              <p className="text-[#555] text-sm mb-6">You can track them in the Jobs view</p>
              <div className="flex gap-3 justify-center">
                <a href="/templates/jobs" className="bg-[#1a1a1a] border border-[#2a2a2a] text-[#999] hover:text-white text-sm px-4 py-2 rounded-lg transition-colors">
                  View jobs →
                </a>
                <button onClick={onClose} className="bg-[#D41020] text-white text-sm px-4 py-2 rounded-lg hover:bg-[#b50d1a] transition-colors">
                  Done
                </button>
              </div>
            </div>
          ) : step === 'pick' ? (
            <PickStep models={models} selected={selected} onToggle={toggleModel} />
          ) : (
            <ReviewStep
              usernames={[...selected]}
              rows={rows}
              onUpdateText={updateText}
              onSelectClip={selectClip}
              originalTemplate={template.text_template}
            />
          )}
        </div>

        {/* Footer */}
        {!done && (
          <div className="px-5 py-4 border-t border-[#1e1e1e] flex items-center justify-between flex-shrink-0">
            {step === 'pick' ? (
              <>
                <span className="text-xs text-[#555]">
                  {selected.size === 0 ? 'Select at least one model' : `${selected.size} model${selected.size !== 1 ? 's' : ''} selected`}
                </span>
                <button
                  disabled={selected.size === 0}
                  onClick={goToReview}
                  className="bg-[#D41020] hover:bg-[#b50d1a] disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
                >
                  Next →
                </button>
              </>
            ) : (
              <>
                <button onClick={() => setStep('pick')} className="text-xs text-[#555] hover:text-white transition-colors">
                  ← Back
                </button>
                <button
                  disabled={submitting}
                  onClick={submitJobs}
                  className="bg-[#D41020] hover:bg-[#b50d1a] disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
                >
                  {submitting ? 'Queuing...' : `Queue ${selected.size} job${selected.size !== 1 ? 's' : ''}`}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function PickStep({ models, selected, onToggle }: { models: Model[]; selected: Set<string>; onToggle: (u: string) => void }) {
  const [search, setSearch] = useState('')
  const filtered = models.filter(m => m.fansly_username.includes(search.toLowerCase()))

  return (
    <div className="flex flex-col gap-3">
      <input
        type="text"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search models..."
        className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#444]"
      />
      <div className="grid grid-cols-2 gap-2">
        {filtered.map(m => {
          const isSelected = selected.has(m.fansly_username)
          return (
            <button
              key={m.fansly_username}
              onClick={() => onToggle(m.fansly_username)}
              className={`text-left px-3 py-2.5 rounded-lg border text-sm transition-colors ${
                isSelected
                  ? 'bg-[#1e0808] border-[#D41020] text-white'
                  : 'bg-[#0a0a0a] border-[#1e1e1e] text-[#888] hover:border-[#2a2a2a] hover:text-white'
              }`}
            >
              <span className="text-[#555] text-xs">@</span>{m.fansly_username}
              {isSelected && <span className="float-right text-[#D41020] text-xs">✓</span>}
            </button>
          )
        })}
      </div>
      {filtered.length === 0 && (
        <p className="text-center py-6 text-[#444] text-sm">No models found</p>
      )}
    </div>
  )
}

function ReviewStep({
  usernames,
  rows,
  onUpdateText,
  onSelectClip,
  originalTemplate,
}: {
  usernames: string[]
  rows: Record<string, ModelRow>
  onUpdateText: (u: string, text: string) => void
  onSelectClip: (u: string, clipId: string | null) => void
  originalTemplate: string
}) {
  return (
    <div className="flex flex-col gap-5">
      {usernames.map(username => {
        const row = rows[username]
        if (!row) return null

        return (
          <div key={username} className="border border-[#1e1e1e] rounded-xl p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-white">@{username}</span>
              {row.status === 'loading' && (
                <span className="text-[10px] text-[#555] flex items-center gap-1.5">
                  <span className="w-3 h-3 border border-[#333] border-t-[#666] rounded-full animate-spin inline-block" />
                  personalizing...
                </span>
              )}
              {row.status === 'error' && <span className="text-[10px] text-red-500">AI failed — using original</span>}
            </div>

            {/* Personalized text */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-[#444] uppercase tracking-wider">Text overlay</label>
              <textarea
                value={row.personalizedText}
                onChange={e => onUpdateText(username, e.target.value)}
                placeholder={originalTemplate}
                rows={row.personalizedText.split('\n').length + 1}
                disabled={row.status === 'loading'}
                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-sm text-white placeholder-[#2e2e2e] focus:outline-none focus:border-[#D41020]/30 resize-none font-mono leading-relaxed disabled:opacity-40"
              />
            </div>

            {/* Clip picker */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-[#444] uppercase tracking-wider">Footage clip</label>
              {row.clipsLoading ? (
                <p className="text-xs text-[#444]">Loading clips...</p>
              ) : row.clips.length === 0 ? (
                <p className="text-xs text-[#444]">No clips uploaded for this model yet</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <button
                    onClick={() => onSelectClip(username, null)}
                    className={`text-left text-xs px-3 py-2 rounded-lg border transition-colors ${
                      row.selectedClipId === null
                        ? 'bg-[#1a1a1a] border-[#D41020]/40 text-[#999]'
                        : 'border-[#1e1e1e] text-[#555] hover:border-[#2a2a2a]'
                    }`}
                  >
                    Auto-pick from pool
                  </button>
                  {row.clips.map(clip => (
                    <button
                      key={clip.id}
                      onClick={() => onSelectClip(username, clip.id)}
                      className={`text-left text-xs px-3 py-2 rounded-lg border transition-colors ${
                        row.selectedClipId === clip.id
                          ? 'bg-[#1e0808] border-[#D41020] text-white'
                          : 'border-[#1e1e1e] text-[#555] hover:border-[#2a2a2a] hover:text-[#888]'
                      }`}
                    >
                      <span className="font-mono">{clip.filename ?? clip.r2_key.split('/').pop()}</span>
                      {clip.duration_seconds && <span className="ml-2 text-[#444]">{clip.duration_seconds}s</span>}
                      {clip.tags?.length > 0 && <span className="ml-2 text-[#444]">{clip.tags.join(', ')}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
