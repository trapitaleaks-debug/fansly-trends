'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import ModelCard, { type ModelSummary, type ScheduleSnapshot } from '@/components/ModelCard'

export default function ModelsPage() {
  const [models, setModels] = useState<ModelSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [generatingAll, setGeneratingAll] = useState(false)
  const [generateAllResult, setGenerateAllResult] = useState<{ triggered: number; failed: number } | null>(null)
  const [scheduleData, setScheduleData] = useState<Record<string, ScheduleSnapshot>>({})
  const [scheduleLoading, setScheduleLoading] = useState(false)
  const [sortByUrgency, setSortByUrgency] = useState(false)
  const [scheduleLastUpdated, setScheduleLastUpdated] = useState<Date | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const router = useRouter()

  useEffect(() => {
    fetchModels()
    // Load any existing snapshots on mount (from a previous sweep)
    fetchSnapshots()
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  async function fetchModels() {
    setLoading(true)
    const res = await fetch('/api/models')
    const data = await res.json()
    setModels(data.models ?? [])
    setLoading(false)
  }

  const fetchSnapshots = useCallback(async (): Promise<ScheduleSnapshot[]> => {
    try {
      const res = await fetch('/api/schedule-check')
      const data = await res.json()
      const snaps: ScheduleSnapshot[] = data.snapshots ?? []
      const map: Record<string, ScheduleSnapshot> = {}
      for (const s of snaps) map[s.model_id] = s
      setScheduleData(map)
      return snaps
    } catch {
      return []
    }
  }, [])

  async function handleGenerateAll() {
    setGeneratingAll(true)
    setGenerateAllResult(null)
    try {
      const res = await fetch('/api/generate-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: 5 }),
      })
      const data = await res.json()
      setGenerateAllResult({ triggered: data.triggered ?? 0, failed: data.failed ?? 0 })
    } catch {
      setGenerateAllResult({ triggered: 0, failed: -1 })
    } finally {
      setGeneratingAll(false)
    }
  }

  async function handleRefreshSchedules() {
    if (scheduleLoading) return
    setScheduleLoading(true)
    // Fire the scrape
    await fetch('/api/schedule-check', { method: 'POST' }).catch(() => {})
    const startedAt = Date.now()
    // Poll every 5s until all models (that we have) have a scraped_at within the last 5 minutes
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      const snaps = await fetchSnapshots()
      const freshCutoff = Date.now() - 5 * 60 * 1000
      // Stop polling after 8 min or when all models have a fresh snapshot
      const modelCount = models.length
      const freshCount = snaps.filter(s => new Date(s.scraped_at).getTime() > startedAt).length
      const timedOut = Date.now() - startedAt > 8 * 60 * 1000
      if (timedOut || (modelCount > 0 && freshCount >= modelCount)) {
        clearInterval(pollRef.current!)
        setScheduleLoading(false)
        setScheduleLastUpdated(new Date())
      }
    }, 5_000)
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!newUsername.trim()) return
    setCreating(true)
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fansly_username: newUsername.trim() }),
    })
    const data = await res.json()
    setCreating(false)
    if (res.ok) {
      setShowForm(false)
      setNewUsername('')
      router.push(`/models/${data.model.fansly_username}`)
    }
  }

  const hasScheduleData = Object.keys(scheduleData).length > 0

  const sortedModels = sortByUrgency && hasScheduleData
    ? [...models].sort((a, b) => {
        const ca = scheduleData[a.id]?.scheduled_count ?? 99
        const cb = scheduleData[b.id]?.scheduled_count ?? 99
        return ca - cb
      })
    : models

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <nav className="bg-[#0f0f0f] border-b border-[#1e1e1e] px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <h1 className="text-sm font-bold text-white">FanslyTrends</h1>
        <div className="flex gap-4 text-xs text-[#666]">
          <Link href="/" className="hover:text-white transition-colors">Feed</Link>
          <Link href="/ideas" className="hover:text-white transition-colors">Ideas</Link>
          <span className="text-white">Models</span>
          <Link href="/generated" className="hover:text-white transition-colors">Generated</Link>
          <Link href="/settings" className="hover:text-white transition-colors">Settings</Link>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold">Model Profiles</h2>
            <p className="text-xs text-[#555] mt-0.5">{models.length} models</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {generateAllResult && (
              <span className="text-xs text-[#666]">
                {generateAllResult.failed === -1
                  ? 'Error — try again'
                  : generateAllResult.triggered === 0
                  ? 'Nothing new to generate'
                  : `Queued ${generateAllResult.triggered} video${generateAllResult.triggered !== 1 ? 's' : ''}${generateAllResult.failed > 0 ? ` (${generateAllResult.failed} failed)` : ''}`}
              </span>
            )}
            <button
              onClick={handleGenerateAll}
              disabled={generatingAll}
              className="bg-[#D41020] hover:bg-[#b50d1a] disabled:opacity-50 text-white text-xs font-medium px-4 py-2 rounded-lg transition-colors"
            >
              {generatingAll ? 'Generating...' : 'Generate All'}
            </button>
            <button
              onClick={handleRefreshSchedules}
              disabled={scheduleLoading}
              className="bg-[#1a1a1a] border border-[#2a2a2a] hover:bg-[#222] disabled:opacity-50 text-[#aaa] hover:text-white text-xs font-medium px-4 py-2 rounded-lg transition-colors"
            >
              {scheduleLoading ? 'Checking...' : '📅 Check Schedules'}
            </button>
            {hasScheduleData && (
              <button
                onClick={() => setSortByUrgency(v => !v)}
                className={`text-xs px-2 py-1.5 rounded border transition-colors ${
                  sortByUrgency
                    ? 'border-amber-500/40 text-amber-400 bg-amber-500/10'
                    : 'border-[#2a2a2a] text-[#555] hover:text-[#888]'
                }`}
              >
                {sortByUrgency ? '↑ Urgency' : 'Sort by urgency'}
              </button>
            )}
            <button
              onClick={() => setShowForm(true)}
              className="bg-white text-black text-xs font-medium px-4 py-2 rounded-lg hover:bg-[#e5e5e5] transition-colors"
            >
              + New Model
            </button>
          </div>
        </div>

        {scheduleLoading && (
          <div className="mb-4 px-3 py-2 bg-[#0f0f0f] border border-[#1e1e1e] rounded-lg flex items-center gap-2 text-xs text-[#555]">
            <div className="w-3 h-3 border border-[#333] border-t-[#666] rounded-full animate-spin shrink-0" />
            Scraping Fansly scheduled posts for all {models.length} models… this takes a few minutes.
          </div>
        )}

        {!scheduleLoading && scheduleLastUpdated && (
          <div className="mb-4 text-xs text-[#444]">
            Schedule data from {scheduleLastUpdated.toLocaleTimeString()}
          </div>
        )}

        {/* Create form */}
        {showForm && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
            <div className="bg-[#111] border border-[#2a2a2a] rounded-2xl p-6 w-full max-w-sm">
              <h3 className="text-sm font-semibold mb-4">Add Model</h3>
              <form onSubmit={handleCreate} className="space-y-3">
                <div>
                  <label className="text-xs text-[#666] block mb-1">Fansly Username</label>
                  <input
                    autoFocus
                    value={newUsername}
                    onChange={e => setNewUsername(e.target.value)}
                    placeholder="e.g. liisaofficial"
                    className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2.5 text-sm text-white placeholder-[#444] focus:outline-none focus:border-[#444]"
                  />
                </div>
                <div className="flex gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={creating || !newUsername.trim()}
                    className="flex-1 bg-white text-black text-xs font-medium py-2.5 rounded-lg hover:bg-[#e5e5e5] disabled:opacity-50 transition-colors"
                  >
                    {creating ? 'Creating...' : 'Create'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowForm(false); setNewUsername('') }}
                    className="flex-1 bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] text-xs py-2.5 rounded-lg hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="w-6 h-6 border-2 border-[#333] border-t-white rounded-full animate-spin" />
          </div>
        ) : models.length === 0 ? (
          <div className="text-center py-20 text-[#444]">
            <p className="text-lg mb-2">No models yet</p>
            <p className="text-sm">Create a profile for each model you manage</p>
          </div>
        ) : (
          <div className="border border-[#1e1e1e] rounded-xl overflow-hidden">
            {sortedModels.map(model => (
              <ModelCard
                key={model.id}
                model={model}
                scheduleSnap={scheduleData[model.id]}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
