'use client'
import { useState, useEffect, useCallback, use } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import SuggestionCard, { type Suggestion } from '@/components/SuggestionCard'

interface Model {
  id: string
  fansly_username: string
  fansly_url: string | null
  branding_file_md: string | null
  hashtags: string[]
  notes_for_ai: string | null
  suggestion_counts: { pending: number; approved: number; done: number; dismissed: number }
  last_generated_at: string | null
  updated_at: string
}

type SuggestionStatus = 'pending' | 'approved' | 'done' | 'dismissed'

export default function ModelDetailPage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = use(params)
  const router = useRouter()

  const [model, setModel] = useState<Model | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<SuggestionStatus>('pending')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [suggestionsLoading, setSuggestionsLoading] = useState(false)
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)

  // Branding file
  const [brandingFileName, setBrandingFileName] = useState<string | null>(null)
  const [brandingUploading, setBrandingUploading] = useState(false)

  // Hashtags
  const [hashtags, setHashtags] = useState<string[]>([])
  const [hashtagInput, setHashtagInput] = useState('')
  const [editingHashtags, setEditingHashtags] = useState(false)
  const [suggestingHashtags, setSuggestingHashtags] = useState(false)
  const [suggestedHashtags, setSuggestedHashtags] = useState<string[]>([])
  const [hashtagError, setHashtagError] = useState<string | null>(null)

  // Notes for AI
  const [notesForAi, setNotesForAi] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [notesSaved, setNotesSaved] = useState(false)

  // Generating
  const [generating, setGenerating] = useState(false)
  const [generateMsg, setGenerateMsg] = useState<string | null>(null)

  // Delete
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Dismiss all
  const [dismissingAll, setDismissingAll] = useState(false)

  useEffect(() => {
    fetchModel()
  }, [username])

  async function fetchModel(silent = false) {
    if (!silent) setLoading(true)
    const res = await fetch(`/api/models/${username}`)
    if (!res.ok) { router.push('/models'); return }
    const data = await res.json()
    setModel(data.model)
    if (!silent) {
      setHashtags(data.model.hashtags ?? [])
      setNotesForAi(data.model.notes_for_ai ?? '')
      if (data.model.branding_file_md) setBrandingFileName('branding-file.md')
      setLoading(false)
    }
  }

  const fetchSuggestions = useCallback(async (status: SuggestionStatus, p: number, replace: boolean) => {
    setSuggestionsLoading(true)
    const res = await fetch(`/api/models/${username}/suggestions?status=${status}&page=${p}`)
    const data = await res.json()
    const items = data.suggestions ?? []
    setSuggestions(prev => replace ? items : [...prev, ...items])
    setHasMore(data.hasMore ?? false)
    setSuggestionsLoading(false)
  }, [username])

  useEffect(() => {
    setPage(0)
    setSuggestions([])
    fetchSuggestions(activeTab, 0, true)
  }, [activeTab, fetchSuggestions])

  async function handleBrandingUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBrandingUploading(true)
    const text = await file.text()
    const res = await fetch(`/api/models/${username}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branding_file_md: text }),
    })
    if (res.ok) {
      setBrandingFileName(file.name)
      await fetchModel()
    }
    setBrandingUploading(false)
    e.target.value = ''
  }

  async function handleSaveHashtags() {
    await fetch(`/api/models/${username}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashtags }),
    })
    setEditingHashtags(false)
    await fetchModel()
  }

  function handleAddHashtag() {
    const tag = hashtagInput.replace('#', '').trim().toLowerCase()
    if (!tag || hashtags.includes(tag) || hashtags.length >= 50) return
    setHashtags(prev => [...prev, tag])
    setHashtagInput('')
  }

  function handleRemoveHashtag(tag: string) {
    setHashtags(prev => prev.filter(t => t !== tag))
  }

  async function handleSuggestHashtags() {
    setSuggestingHashtags(true)
    setSuggestedHashtags([])
    setHashtagError(null)
    const res = await fetch(`/api/models/${username}/suggest-hashtags`, { method: 'POST' })
    const data = await res.json()
    setSuggestingHashtags(false)
    if (res.ok) {
      setSuggestedHashtags(data.hashtags ?? [])
    } else {
      setHashtagError(data.error ?? 'Failed to suggest hashtags')
    }
  }

  function handleAddSuggestedHashtag(tag: string) {
    if (!hashtags.includes(tag) && hashtags.length < 50) {
      setHashtags(prev => [...prev, tag])
      setEditingHashtags(true) // show Save button automatically
    }
    setSuggestedHashtags(prev => prev.filter(t => t !== tag))
  }

  async function handleSaveNotes() {
    setSavingNotes(true)
    await fetch(`/api/models/${username}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes_for_ai: notesForAi }),
    })
    setSavingNotes(false)
    setNotesSaved(true)
    setTimeout(() => setNotesSaved(false), 2000)
  }

  async function handleGenerate() {
    setGenerating(true)
    setGenerateMsg(null)
    const res = await fetch(`/api/models/${username}/suggestions/generate`, { method: 'POST' })
    const data = await res.json()
    setGenerating(false)
    if (res.ok) {
      setGenerateMsg(`Generated ${data.generated} new suggestions`)
      setActiveTab('pending')
      setPage(0)
      fetchSuggestions('pending', 0, true).then(() => fetchModel(true))
    } else {
      setGenerateMsg(data.error ?? 'Generation failed')
    }
  }

  async function handleStatusChange(id: string, status: SuggestionStatus, dismissReason?: string) {
    const body: Record<string, unknown> = { status }
    if (dismissReason) body.dismiss_reason = dismissReason
    await fetch(`/api/models/${username}/suggestions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setSuggestions(prev => prev.filter(s => s.id !== id))
    fetchModel(true)
  }

  function handleFieldsUpdate(id: string, fields: Partial<Suggestion>) {
    setSuggestions(prev => prev.map(s => s.id === id ? { ...s, ...fields } : s))
  }

  async function handleDelete() {
    await fetch(`/api/models/${username}`, { method: 'DELETE' })
    router.push('/models')
  }

  async function handleDismissAll() {
    setDismissingAll(true)
    await fetch(`/api/models/${username}/suggestions/dismiss-all`, { method: 'POST' })
    setSuggestions([])
    setDismissingAll(false)
    fetchModel(true)
  }

  function handleLoadMore() {
    const next = page + 1
    setPage(next)
    fetchSuggestions(activeTab, next, false)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-[#333] border-t-white rounded-full animate-spin" />
      </div>
    )
  }

  if (!model) return null

  const tabCount = (tab: SuggestionStatus) => model.suggestion_counts[tab]

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <nav className="bg-[#0f0f0f] border-b border-[#1e1e1e] px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <h1 className="text-sm font-bold text-white">FanslyTrends</h1>
        <div className="flex gap-4 text-xs text-[#666]">
          <Link href="/" className="hover:text-white transition-colors">Feed</Link>
          <Link href="/ideas" className="hover:text-white transition-colors">Ideas</Link>
          <Link href="/models" className="hover:text-white transition-colors">Models</Link>
          
          <Link href="/pipeline" className="hover:text-white transition-colors">Pipeline</Link>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold">@{model.fansly_username}</h2>
            </div>
            <a
              href={model.fansly_url ?? `https://fansly.com/${model.fansly_username}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[#555] hover:text-[#888] transition-colors mt-0.5 block"
            >
              fansly.com/{model.fansly_username} ↗
            </a>
          </div>
          <div className="flex gap-2">
            {!confirmDelete ? (
              <button
                onClick={() => setConfirmDelete(true)}
                className="text-xs text-[#444] hover:text-red-400 border border-[#1e1e1e] hover:border-red-400/30 px-3 py-1.5 rounded-lg transition-colors"
              >
                Delete
              </button>
            ) : (
              <div className="flex gap-2 items-center">
                <span className="text-xs text-[#666]">Are you sure?</span>
                <button onClick={handleDelete} className="text-xs text-red-400 hover:text-red-300 px-3 py-1.5 rounded-lg border border-red-400/30 transition-colors">
                  Yes, delete
                </button>
                <button onClick={() => setConfirmDelete(false)} className="text-xs text-[#666] hover:text-white px-3 py-1.5 rounded-lg transition-colors">
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Branding File */}
        <div className="bg-[#111] border border-[#1e1e1e] rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Personal Branding File</h3>
            <label className="cursor-pointer">
              <input type="file" accept=".md,.txt" className="hidden" onChange={handleBrandingUpload} />
              <span className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:text-white px-3 py-1.5 rounded-lg transition-colors inline-block">
                {brandingUploading ? 'Uploading...' : brandingFileName ? 'Replace file' : 'Upload .md file'}
              </span>
            </label>
          </div>
          {brandingFileName && model.branding_file_md ? (
            <div>
              <p className="text-xs text-green-400 mb-2">{brandingFileName} uploaded</p>
              <p className="text-xs text-[#555] bg-[#0a0a0a] border border-[#1a1a1a] rounded-lg p-3 font-mono leading-relaxed line-clamp-4">
                {model.branding_file_md.slice(0, 300)}{model.branding_file_md.length > 300 ? '...' : ''}
              </p>
            </div>
          ) : (
            <p className="text-xs text-[#444]">No branding file yet. Upload the model&apos;s Personal Branding .md file to enable AI suggestions.</p>
          )}
        </div>

        {/* Hashtags */}
        <div className="bg-[#111] border border-[#1e1e1e] rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">
              Hashtags <span className="text-[#555] font-normal">({hashtags.length}/50)</span>
            </h3>
            <div className="flex gap-2">
              {model.branding_file_md && (
                <button
                  onClick={handleSuggestHashtags}
                  disabled={suggestingHashtags}
                  className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:text-white px-3 py-1.5 rounded-lg disabled:opacity-50 transition-colors"
                >
                  {suggestingHashtags ? 'Thinking...' : 'AI Suggest'}
                </button>
              )}
              {!editingHashtags ? (
                <button
                  onClick={() => setEditingHashtags(true)}
                  className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:text-white px-3 py-1.5 rounded-lg transition-colors"
                >
                  Edit
                </button>
              ) : (
                <button
                  onClick={handleSaveHashtags}
                  className="text-xs bg-white text-black px-3 py-1.5 rounded-lg hover:bg-[#e5e5e5] transition-colors"
                >
                  Save
                </button>
              )}
            </div>
          </div>

          {/* Existing hashtags */}
          <div className="flex flex-wrap gap-2">
            {hashtags.map(tag => (
              <span
                key={tag}
                className="flex items-center gap-1 bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] text-xs px-2.5 py-1 rounded-full"
              >
                #{tag}
                {editingHashtags && (
                  <button
                    onClick={() => handleRemoveHashtag(tag)}
                    className="text-[#555] hover:text-red-400 ml-0.5 leading-none"
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            {hashtags.length === 0 && (
              <span className="text-xs text-[#444]">No hashtags yet</span>
            )}
          </div>

          {/* Add hashtag input */}
          {editingHashtags && hashtags.length < 50 && (
            <div className="flex gap-2">
              <input
                value={hashtagInput}
                onChange={e => setHashtagInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddHashtag() } }}
                placeholder="#hashtag"
                className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-xs text-white placeholder-[#444] focus:outline-none focus:border-[#444]"
              />
              <button
                onClick={handleAddHashtag}
                className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:text-white px-3 py-2 rounded-lg transition-colors"
              >
                Add
              </button>
            </div>
          )}

          {hashtagError && (
            <p className="text-xs text-red-400 border-t border-[#1a1a1a] pt-2">{hashtagError}</p>
          )}

          {/* AI suggested hashtags */}
          {suggestedHashtags.length > 0 && (
            <div className="border-t border-[#1a1a1a] pt-3 space-y-2">
              <p className="text-xs text-[#555]">AI suggestions — click to add:</p>
              <div className="flex flex-wrap gap-2">
                {suggestedHashtags.map(tag => (
                  <button
                    key={tag}
                    onClick={() => handleAddSuggestedHashtag(tag)}
                    disabled={hashtags.includes(tag) || hashtags.length >= 50}
                    className="bg-blue-500/10 border border-blue-500/20 text-blue-400 hover:bg-blue-500/20 disabled:opacity-30 text-xs px-2.5 py-1 rounded-full transition-colors"
                  >
                    + #{tag}
                  </button>
                ))}
              </div>
              {editingHashtags && (
                <button
                  onClick={handleSaveHashtags}
                  className="text-xs bg-white text-black px-4 py-1.5 rounded-lg hover:bg-[#e5e5e5] transition-colors"
                >
                  Save hashtags
                </button>
              )}
            </div>
          )}
        </div>

        {/* Notes for AI */}
        <div className="bg-[#111] border border-[#1e1e1e] rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium">Notes for AI</h3>
              <p className="text-xs text-[#444] mt-0.5">Constraints and context passed to Claude when generating suggestions</p>
            </div>
            <button
              onClick={handleSaveNotes}
              disabled={savingNotes}
              className="text-xs bg-white text-black px-3 py-1.5 rounded-lg hover:bg-[#e5e5e5] disabled:opacity-50 transition-colors"
            >
              {notesSaved ? 'Saved ✓' : savingNotes ? 'Saving...' : 'Save'}
            </button>
          </div>
          <textarea
            value={notesForAi}
            onChange={e => setNotesForAi(e.target.value)}
            placeholder={"Examples:\n- Only uses AI-generated content, never real video\n- Cannot film outside the house\n- Prefers simple setups (bedroom only)\n- Always wears lingerie, never fully nude on FYP"}
            rows={5}
            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2.5 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#444] resize-none font-mono leading-relaxed"
          />
        </div>

        {/* AI Suggestions */}
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <h3 className="text-sm font-medium">AI Suggestions</h3>
            <div className="flex items-center gap-3">
              {generateMsg && (
                <span className={`text-xs ${generateMsg.includes('Generated') ? 'text-green-400' : 'text-red-400'}`}>
                  {generateMsg}
                </span>
              )}
              <button
                onClick={handleGenerate}
                disabled={generating || !model.branding_file_md}
                className="text-xs bg-white text-black font-medium px-4 py-2 rounded-lg hover:bg-[#e5e5e5] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title={!model.branding_file_md ? 'Upload a branding file first' : undefined}
              >
                {generating ? 'Generating...' : 'Generate Suggestions'}
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-2">
            <div className="flex flex-1 gap-1 bg-[#111] border border-[#1e1e1e] rounded-xl p-1">
              {(['pending', 'approved', 'dismissed'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex-1 text-xs py-2 rounded-lg capitalize transition-colors ${
                    activeTab === tab
                      ? 'bg-white text-black font-medium'
                      : 'text-[#666] hover:text-[#999]'
                  }`}
                >
                  {tab} {tabCount(tab) > 0 && `(${tabCount(tab)})`}
                </button>
              ))}
            </div>
            {activeTab === 'pending' && tabCount('pending') > 0 && (
              <button
                onClick={handleDismissAll}
                disabled={dismissingAll}
                className="text-xs text-[#444] hover:text-red-400 border border-[#1e1e1e] hover:border-red-400/30 px-3 py-2 rounded-xl transition-colors disabled:opacity-50 whitespace-nowrap"
              >
                {dismissingAll ? 'Dismissing...' : 'Dismiss all'}
              </button>
            )}
          </div>

          {/* Suggestions list */}
          <div className="space-y-3">
            {suggestions.map(s => (
              <SuggestionCard
                key={s.id}
                suggestion={s}
                username={username}
                onStatusChange={handleStatusChange}
                onFieldsUpdate={handleFieldsUpdate}
              />
            ))}
          </div>

          {suggestionsLoading && (
            <div className="flex justify-center py-8">
              <div className="w-5 h-5 border-2 border-[#333] border-t-white rounded-full animate-spin" />
            </div>
          )}

          {!suggestionsLoading && suggestions.length === 0 && (
            <div className="text-center py-12 text-[#444]">
              {activeTab === 'pending' && !model.branding_file_md ? (
                <>
                  <p className="text-sm mb-1">Upload a branding file first</p>
                  <p className="text-xs">Then click &quot;Generate Suggestions&quot; to get AI recommendations</p>
                </>
              ) : activeTab === 'pending' ? (
                <>
                  <p className="text-sm mb-1">No pending suggestions</p>
                  <p className="text-xs">Click &quot;Generate Suggestions&quot; to analyze trending posts</p>
                </>
              ) : (
                <p className="text-sm">No {activeTab} suggestions</p>
              )}
            </div>
          )}

          {!suggestionsLoading && hasMore && (
            <div className="flex justify-center">
              <button
                onClick={handleLoadMore}
                className="bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:text-white text-xs px-6 py-2 rounded-lg transition-colors"
              >
                Load more
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
