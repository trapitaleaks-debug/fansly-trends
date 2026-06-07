'use client'
import { useState, useEffect, useCallback, use } from 'react'
import Link from 'next/link'

interface ContentBankItem {
  id: string
  type: 'own_footage' | 'hook_clip' | 'audio'
  r2_key: string
  label: string
  created_at: string
}

interface PipelineModelDetail {
  id: string
  handle: string
  status: 'active' | 'inactive'
  videos_per_cycle: number
  flash_frame_enabled: boolean
  notes_for_ai: string | null
  character_sheet_r2_key: string | null
  character_sheet_generated_at: string | null
  pinned_character_sheet_key: string | null
  content_bank: ContentBankItem[]
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        checked ? 'bg-violet-500' : 'bg-[#333]'
      }`}
      type="button"
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
          checked ? 'translate-x-4.5' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

function UploadSection({
  modelId,
  type,
  label: sectionLabel,
  accept,
  items,
  onUploaded,
  onDelete,
}: {
  modelId: string
  type: 'own_footage' | 'hook_clip' | 'audio'
  label: string
  accept: string
  items: ContentBankItem[]
  onUploaded: () => void
  onDelete: (id: string) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [fileLabel, setFileLabel] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  async function handleUpload() {
    if (!file) return
    setUploading(true)
    setUploadError(null)

    // 1. Get upload URL
    const res = await fetch('/api/pipeline/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_id: modelId,
        type,
        filename: file.name,
        label: fileLabel || file.name,
      }),
    })

    if (!res.ok) {
      const data = await res.json()
      setUploadError(data.error ?? 'Failed to get upload URL')
      setUploading(false)
      return
    }

    const { uploadUrl } = await res.json()

    // 2. PUT file directly to R2
    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    })

    setUploading(false)

    if (!putRes.ok) {
      setUploadError('Upload to storage failed')
      return
    }

    setFile(null)
    setFileLabel('')
    onUploaded()
  }

  async function handleDelete(itemId: string) {
    setDeletingId(itemId)
    await fetch(`/api/pipeline/content-bank/${modelId}?id=${itemId}`, { method: 'DELETE' })
    setDeletingId(null)
    onDelete(itemId)
  }

  const typeItems = items.filter(i => i.type === type)

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-medium text-[#888]">{sectionLabel}</h4>

      {/* Upload form */}
      <div className="bg-[#0a0a0a] border border-[#1e1e1e] rounded-lg p-4 space-y-3">
        <div className="flex gap-2">
          <label className="flex-1">
            <input
              type="file"
              accept={accept}
              className="hidden"
              onChange={e => { setFile(e.target.files?.[0] ?? null); setUploadError(null) }}
            />
            <span className="block text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:text-white px-3 py-2 rounded-lg cursor-pointer transition-colors truncate">
              {file ? file.name : 'Choose file...'}
            </span>
          </label>
          <input
            value={fileLabel}
            onChange={e => setFileLabel(e.target.value)}
            placeholder="Label (optional)"
            className="flex-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-xs text-white placeholder-[#444] focus:outline-none focus:border-[#444]"
          />
          <button
            onClick={handleUpload}
            disabled={!file || uploading}
            className="text-xs bg-white text-black px-3 py-2 rounded-lg hover:bg-[#e5e5e5] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            {uploading ? 'Uploading...' : 'Upload'}
          </button>
        </div>
        {uploadError && <p className="text-xs text-red-400">{uploadError}</p>}
      </div>

      {/* Item list */}
      {typeItems.length > 0 ? (
        <div className="space-y-2">
          {typeItems.map(item => (
            <div
              key={item.id}
              className="flex items-center justify-between bg-[#0a0a0a] border border-[#1e1e1e] rounded-lg px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-xs text-[#ccc] truncate">{item.label}</p>
                <p className="text-[10px] text-[#444] truncate">{item.r2_key.split('/').pop()}</p>
              </div>
              <button
                onClick={() => handleDelete(item.id)}
                disabled={deletingId === item.id}
                className="text-xs text-[#444] hover:text-red-400 disabled:opacity-50 transition-colors ml-3 shrink-0"
              >
                {deletingId === item.id ? '...' : 'Delete'}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-[#444]">No files uploaded yet</p>
      )}
    </div>
  )
}

export default function ModelSettingsPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = use(params)

  const [model, setModel] = useState<PipelineModelDetail | null>(null)
  const [loading, setLoading] = useState(true)

  // Settings state
  const [videosPerCycle, setVideosPerCycle] = useState(6)
  const [flashFrameEnabled, setFlashFrameEnabled] = useState(false)
  const [notesForAi, setNotesForAi] = useState('')
  const [savingSettings, setSavingSettings] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)

  // Pin character sheet
  const [pinning, setPinning] = useState(false)
  const [pinned, setPinned] = useState(false)

  const fetchModel = useCallback(async () => {
    const res = await fetch(`/api/pipeline/models/${handle}`)
    if (res.ok) {
      const data = await res.json()
      const m: PipelineModelDetail = { ...data.model, content_bank: data.model.content_bank ?? [] }
      setModel(m)
      setVideosPerCycle(m.videos_per_cycle)
      setFlashFrameEnabled(m.flash_frame_enabled)
      setNotesForAi(m.notes_for_ai ?? '')
      setPinned(!!m.pinned_character_sheet_key)
    }
    setLoading(false)
  }, [handle])

  useEffect(() => {
    fetchModel()
  }, [fetchModel])

  async function handleSaveSettings() {
    setSavingSettings(true)
    await fetch(`/api/pipeline/models/${handle}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videos_per_cycle: videosPerCycle,
        flash_frame_enabled: flashFrameEnabled,
        notes_for_ai: notesForAi,
      }),
    })
    setSavingSettings(false)
    setSettingsSaved(true)
    setTimeout(() => setSettingsSaved(false), 2000)
  }

  async function handlePinCharacterSheet() {
    if (!model?.character_sheet_r2_key) return
    setPinning(true)
    await fetch(`/api/pipeline/models/${handle}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned_character_sheet_key: model.character_sheet_r2_key }),
    })
    setPinning(false)
    setPinned(true)
    fetchModel()
  }

  function handleItemDeleted(itemId: string) {
    setModel(prev => {
      if (!prev) return prev
      return { ...prev, content_bank: prev.content_bank.filter(i => i.id !== itemId) }
    })
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-[#333] border-t-white rounded-full animate-spin" />
      </div>
    )
  }

  if (!model) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center text-[#555]">
        <p className="text-sm">Model not found</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <nav className="bg-[#0f0f0f] border-b border-[#1e1e1e] px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <h1 className="text-sm font-bold text-white">FanslyTrends</h1>
        <div className="flex gap-4 text-xs text-[#666]">
          <Link href="/" className="hover:text-white transition-colors">Feed</Link>
          <Link href="/ideas" className="hover:text-white transition-colors">Ideas</Link>
          <Link href="/models" className="hover:text-white transition-colors">Models</Link>
          <Link href="/settings" className="hover:text-white transition-colors">Settings</Link>
          <Link href="/pipeline" className="text-white">Pipeline</Link>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">

        {/* Header */}
        <div className="space-y-1">
          <Link
            href="/pipeline"
            className="text-xs text-[#555] hover:text-white transition-colors inline-flex items-center gap-1"
          >
            ← Back to Pipeline
          </Link>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold">@{model.handle} — Model Settings</h2>
            <span className={`text-xs px-2 py-0.5 rounded-full border ${
              model.status === 'active'
                ? 'text-green-400 border-green-400/20 bg-green-400/5'
                : 'text-[#555] border-[#2a2a2a] bg-[#1a1a1a]'
            }`}>
              {model.status}
            </span>
          </div>
        </div>

        {/* Settings */}
        <div className="bg-[#111] border border-[#1a1a1a] rounded-xl p-6 space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Settings</h3>
            <button
              onClick={handleSaveSettings}
              disabled={savingSettings}
              className="text-xs bg-white text-black px-4 py-1.5 rounded-lg hover:bg-[#e5e5e5] disabled:opacity-50 transition-colors"
            >
              {settingsSaved ? 'Saved ✓' : savingSettings ? 'Saving...' : 'Save'}
            </button>
          </div>

          {/* videos_per_cycle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-[#ccc]">Videos per cycle</p>
              <p className="text-xs text-[#444] mt-0.5">How many videos to generate per run</p>
            </div>
            <input
              type="number"
              min={1}
              max={12}
              value={videosPerCycle}
              onChange={e => setVideosPerCycle(Math.min(12, Math.max(1, parseInt(e.target.value) || 1)))}
              className="w-16 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-1.5 text-sm text-white text-center focus:outline-none focus:border-[#444]"
            />
          </div>

          {/* flash_frame_enabled */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-[#ccc]">Flash frame</p>
              <p className="text-xs text-[#444] mt-0.5">Add a 1-frame flash cut to the intro</p>
            </div>
            <Toggle checked={flashFrameEnabled} onChange={setFlashFrameEnabled} />
          </div>

          {/* notes_for_ai */}
          <div className="space-y-2">
            <div>
              <p className="text-sm text-[#ccc]">Notes for AI</p>
              <p className="text-xs text-[#444] mt-0.5">
                This text is read by Claude when generating content
              </p>
            </div>
            <textarea
              value={notesForAi}
              onChange={e => setNotesForAi(e.target.value)}
              rows={5}
              placeholder="E.g. Only AI-generated visuals, bedroom aesthetic, always keep it tasteful..."
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2.5 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#444] resize-none font-mono leading-relaxed"
            />
          </div>
        </div>

        {/* Character sheet */}
        <div className="bg-[#111] border border-[#1a1a1a] rounded-xl p-6 space-y-4">
          <h3 className="text-sm font-medium">Character Sheet</h3>
          {model.character_sheet_r2_key ? (
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs text-[#ccc]">Character sheet exists</p>
                {model.character_sheet_generated_at && (
                  <p className="text-xs text-[#444] mt-0.5">
                    Generated {new Date(model.character_sheet_generated_at).toLocaleDateString()}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {pinned || model.pinned_character_sheet_key ? (
                  <span className="text-xs text-green-400 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                    Pinned ✓
                  </span>
                ) : (
                  <button
                    onClick={handlePinCharacterSheet}
                    disabled={pinning}
                    className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:text-white px-3 py-1.5 rounded-lg disabled:opacity-50 transition-colors"
                  >
                    {pinning ? 'Pinning...' : 'Pin this version'}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <p className="text-xs text-[#444]">No character sheet generated yet. Run a generation to create one.</p>
          )}
        </div>

        {/* Content bank */}
        <div className="bg-[#111] border border-[#1a1a1a] rounded-xl p-6 space-y-6">
          <h3 className="text-sm font-medium">Content Bank</h3>

          <UploadSection
            modelId={model.id}
            type="own_footage"
            label="Own Footage"
            accept="video/*"
            items={model.content_bank}
            onUploaded={fetchModel}
            onDelete={handleItemDeleted}
          />

          <div className="border-t border-[#1a1a1a]" />

          <UploadSection
            modelId={model.id}
            type="hook_clip"
            label="Hook Clips"
            accept="video/*"
            items={model.content_bank}
            onUploaded={fetchModel}
            onDelete={handleItemDeleted}
          />

          <div className="border-t border-[#1a1a1a]" />

          <UploadSection
            modelId={model.id}
            type="audio"
            label="Audio Files"
            accept="audio/*"
            items={model.content_bank}
            onUploaded={fetchModel}
            onDelete={handleItemDeleted}
          />
        </div>

      </div>
    </div>
  )
}
