'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'

interface PipelineModel {
  id: string
  handle: string
  status: 'active' | 'inactive'
  videos_per_cycle: number
  last_run?: {
    id: string
    status: string
    created_at: string
    slot_count: number
  } | null
}

interface PipelineRun {
  id: string
  handle: string
  status: string
  created_at: string
  slot_count: number
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    ready: 'text-green-400',
    generating: 'text-blue-400 animate-pulse',
    processing: 'text-blue-400 animate-pulse',
    queued: 'text-yellow-400',
    failed: 'text-red-400',
    active: 'text-green-400',
    inactive: 'text-[#555]',
  }
  const dots: Record<string, string> = {
    ready: 'bg-green-400',
    generating: 'bg-blue-400',
    processing: 'bg-blue-400',
    queued: 'bg-yellow-400',
    failed: 'bg-red-400',
    active: 'bg-green-400',
    inactive: 'bg-[#555]',
  }
  const cls = styles[status] ?? 'text-[#555]'
  const dot = dots[status] ?? 'bg-[#555]'
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot} ${status === 'generating' || status === 'processing' ? 'animate-pulse' : ''}`} />
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

export default function PipelinePage() {
  const [models, setModels] = useState<PipelineModel[]>([])
  const [runs, setRuns] = useState<PipelineRun[]>([])
  const [loading, setLoading] = useState(true)
  const [runsLoading, setRunsLoading] = useState(true)
  const [generating, setGenerating] = useState<Record<string, boolean>>({})
  const [queued, setQueued] = useState<Record<string, boolean>>({})
  const [retrying, setRetrying] = useState<Record<string, boolean>>({})

  // Add model form
  const [showAddForm, setShowAddForm] = useState(false)
  const [newHandle, setNewHandle] = useState('')
  const [addingModel, setAddingModel] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const fetchModels = useCallback(async () => {
    const res = await fetch('/api/pipeline/models')
    if (res.ok) {
      const data = await res.json()
      setModels(data.models ?? [])
    }
    setLoading(false)
  }, [])

  const fetchRuns = useCallback(async () => {
    const res = await fetch('/api/pipeline/runs')
    if (res.ok) {
      const data = await res.json()
      setRuns(data.runs ?? [])
    }
    setRunsLoading(false)
  }, [])

  // Auto-poll while any run is active
  useEffect(() => {
    const hasActive = runs.some(r => r.status === 'queued' || r.status === 'generating' || r.status === 'processing')
    if (!hasActive) return
    const id = setInterval(() => { fetchRuns(); fetchModels() }, 12_000)
    return () => clearInterval(id)
  }, [runs, fetchRuns, fetchModels])

  useEffect(() => {
    fetchModels()
    fetchRuns()
  }, [fetchModels, fetchRuns])

  async function handleGenerate(handle: string) {
    setGenerating(prev => ({ ...prev, [handle]: true }))
    const res = await fetch('/api/pipeline/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    })
    setGenerating(prev => ({ ...prev, [handle]: false }))
    if (res.ok) {
      setQueued(prev => ({ ...prev, [handle]: true }))
      setTimeout(() => setQueued(prev => ({ ...prev, [handle]: false })), 2500)
      fetchRuns()
      fetchModels()
    }
  }

  async function handleRetry(run: PipelineRun) {
    setRetrying(prev => ({ ...prev, [run.id]: true }))
    await fetch('/api/pipeline/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: run.handle }),
    })
    setRetrying(prev => ({ ...prev, [run.id]: false }))
    fetchRuns()
  }

  async function handleAddModel(e: React.FormEvent) {
    e.preventDefault()
    const handle = newHandle.replace('@', '').trim()
    if (!handle) return
    setAddingModel(true)
    setAddError(null)
    const res = await fetch('/api/pipeline/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    })
    setAddingModel(false)
    if (res.ok) {
      setNewHandle('')
      setShowAddForm(false)
      fetchModels()
    } else {
      const data = await res.json()
      setAddError(data.error ?? 'Failed to add model')
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <nav className="bg-[#0f0f0f] border-b border-[#1e1e1e] px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <h1 className="text-sm font-bold text-white">FanslyTrends</h1>
        <div className="flex gap-4 text-xs text-[#666]">
          <Link href="/" className="hover:text-white transition-colors">Feed</Link>
          <Link href="/ideas" className="hover:text-white transition-colors">Ideas</Link>
          <Link href="/models" className="hover:text-white transition-colors">Models</Link>
          
          <span className="text-white">Pipeline</span>
        </div>
      </nav>

      <div className="max-w-5xl mx-auto px-4 py-8 space-y-10">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Production Queue</h2>
            <p className="text-xs text-[#555] mt-0.5">Manage pipeline models and trigger video generation</p>
          </div>
          <button
            onClick={() => { setShowAddForm(v => !v); setAddError(null); setNewHandle('') }}
            className="text-xs bg-white text-black font-medium px-4 py-2 rounded-lg hover:bg-[#e5e5e5] transition-colors"
          >
            + Add Model
          </button>
        </div>

        {/* Add model form */}
        {showAddForm && (
          <form onSubmit={handleAddModel} className="bg-[#111] border border-[#1e1e1e] rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-medium">Add Pipeline Model</h3>
            <div className="flex gap-2">
              <input
                value={newHandle}
                onChange={e => setNewHandle(e.target.value)}
                placeholder="@handle"
                autoFocus
                className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-sm text-white placeholder-[#444] focus:outline-none focus:border-[#444]"
              />
              <button
                type="submit"
                disabled={addingModel || !newHandle.trim()}
                className="text-xs bg-white text-black px-4 py-2 rounded-lg hover:bg-[#e5e5e5] disabled:opacity-50 transition-colors"
              >
                {addingModel ? 'Adding...' : 'Add'}
              </button>
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="text-xs text-[#555] hover:text-white px-3 py-2 transition-colors"
              >
                Cancel
              </button>
            </div>
            {addError && <p className="text-xs text-red-400">{addError}</p>}
          </form>
        )}

        {/* Model cards */}
        <div className="space-y-3">
          <h3 className="text-xs font-medium text-[#555] uppercase tracking-wider">Models</h3>
          {loading ? (
            <div className="flex justify-center py-12">
              <div className="w-5 h-5 border-2 border-[#333] border-t-white rounded-full animate-spin" />
            </div>
          ) : models.length === 0 ? (
            <div className="text-center py-12 text-[#444]">
              <p className="text-sm">No pipeline models yet</p>
              <p className="text-xs mt-1">Click &quot;+ Add Model&quot; to get started</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {models.map(model => (
                <div key={model.id} className="bg-[#111] border border-[#1a1a1a] rounded-xl p-5 space-y-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">@{model.handle}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <StatusBadge status={model.status} />
                        <span className="text-xs text-[#444]">{model.videos_per_cycle} videos/cycle</span>
                      </div>
                    </div>
                    <Link
                      href={`/pipeline/models/${model.handle}`}
                      className="text-xs text-[#444] hover:text-violet-400 border border-[#1e1e1e] px-2.5 py-1 rounded-lg transition-colors"
                    >
                      Settings
                    </Link>
                  </div>

                  <div className="border-t border-[#1a1a1a] pt-3 space-y-1">
                    <p className="text-xs text-[#444]">Last run</p>
                    {model.last_run ? (
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <StatusBadge status={model.last_run.status} />
                          <span className="text-xs text-[#555]">{timeAgo(model.last_run.created_at)}</span>
                          <span className="text-xs text-[#444]">{model.last_run.slot_count} slots</span>
                        </div>
                        <Link
                          href={`/pipeline/${model.last_run.id}`}
                          className="text-xs text-violet-400 hover:text-violet-300 transition-colors"
                        >
                          {model.last_run.status === 'ready' ? 'Review →' : 'View →'}
                        </Link>
                      </div>
                    ) : (
                      <p className="text-xs text-[#444]">No runs yet</p>
                    )}
                  </div>

                  <button
                    onClick={() => handleGenerate(model.handle)}
                    disabled={generating[model.handle] || model.status === 'inactive'}
                    className="w-full text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:text-white hover:border-[#444] py-2 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {queued[model.handle] ? 'Queued ✓' : generating[model.handle] ? 'Queuing...' : 'Generate'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent runs */}
        <div className="space-y-3">
          <h3 className="text-xs font-medium text-[#555] uppercase tracking-wider">Recent Runs</h3>
          {runsLoading ? (
            <div className="flex justify-center py-8">
              <div className="w-5 h-5 border-2 border-[#333] border-t-white rounded-full animate-spin" />
            </div>
          ) : runs.length === 0 ? (
            <p className="text-xs text-[#444] py-4 text-center">No runs yet</p>
          ) : (
            <div className="bg-[#111] border border-[#1a1a1a] rounded-xl overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[#1a1a1a]">
                    <th className="text-left text-[#555] font-normal px-4 py-3">Model</th>
                    <th className="text-left text-[#555] font-normal px-4 py-3">Status</th>
                    <th className="text-left text-[#555] font-normal px-4 py-3">Created</th>
                    <th className="text-left text-[#555] font-normal px-4 py-3">Slots</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run, i) => (
                    <tr
                      key={run.id}
                      className={`${i < runs.length - 1 ? 'border-b border-[#1a1a1a]' : ''} hover:bg-[#0f0f0f] transition-colors cursor-pointer`}
                      onClick={() => window.location.href = `/pipeline/${run.id}`}
                    >
                      <td className="px-4 py-3 text-[#ccc]">@{run.handle}</td>
                      <td className="px-4 py-3"><StatusBadge status={run.status} /></td>
                      <td className="px-4 py-3 text-[#555]">{timeAgo(run.created_at)}</td>
                      <td className="px-4 py-3 text-[#555]">{run.slot_count}</td>
                      <td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
                        {run.status === 'ready' && (
                          <Link
                            href={`/pipeline/${run.id}`}
                            className="text-violet-400 hover:text-violet-300 transition-colors"
                          >
                            Review →
                          </Link>
                        )}
                        {run.status === 'failed' && (
                          <button
                            onClick={() => handleRetry(run)}
                            disabled={retrying[run.id]}
                            className="text-[#666] hover:text-white disabled:opacity-50 transition-colors"
                          >
                            {retrying[run.id] ? 'Retrying...' : 'Retry'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
