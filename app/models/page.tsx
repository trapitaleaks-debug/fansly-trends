'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import ModelCard, { type ModelSummary } from '@/components/ModelCard'

export default function ModelsPage() {
  const [models, setModels] = useState<ModelSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [showForm, setShowForm] = useState(false)
  const router = useRouter()

  useEffect(() => {
    fetchModels()
  }, [])

  async function fetchModels() {
    setLoading(true)
    const res = await fetch('/api/models')
    const data = await res.json()
    setModels(data.models ?? [])
    setLoading(false)
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

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <nav className="bg-[#0f0f0f] border-b border-[#1e1e1e] px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <h1 className="text-sm font-bold text-white">FanslyTrends</h1>
        <div className="flex gap-4 text-xs text-[#666]">
          <Link href="/" className="hover:text-white transition-colors">Feed</Link>
          <Link href="/ideas" className="hover:text-white transition-colors">Ideas</Link>
          <span className="text-white">Models</span>
          
          <Link href="/pipeline" className="hover:text-white transition-colors">Pipeline</Link>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold">Model Profiles</h2>
            <p className="text-xs text-[#555] mt-0.5">{models.length} models · AI-powered content suggestions</p>
          </div>
          <button
            onClick={() => setShowForm(true)}
            className="bg-white text-black text-xs font-medium px-4 py-2 rounded-lg hover:bg-[#e5e5e5] transition-colors"
          >
            + New Model
          </button>
        </div>

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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {models.map(model => (
              <ModelCard key={model.id} model={model} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
