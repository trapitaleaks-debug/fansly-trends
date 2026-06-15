'use client'
import { useState, useEffect, useCallback, useRef } from 'react'

export interface ContentBankItem {
  id: string
  r2_key: string
  label: string | null
  tags: string[]
  trim_start: number
  trim_end: number | null
  created_at: string
}

function TagChips({ tags, presetTags, onChange }: { tags: string[]; presetTags: string[]; onChange: (t: string[]) => void }) {
  const [newTag, setNewTag] = useState('')

  function add(tag: string) {
    const t = tag.trim().toLowerCase()
    if (!t || tags.includes(t)) return
    onChange([...tags, t])
    setNewTag('')
  }

  function remove(tag: string) {
    onChange(tags.filter(t => t !== tag))
  }

  const available = presetTags.filter(t => !tags.includes(t))

  return (
    <div className="space-y-1.5">
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map(tag => (
            <span key={tag} className="flex items-center gap-1 text-[10px] pl-2 pr-1 py-0.5 rounded-full bg-violet-500/20 border border-violet-500/40 text-violet-300">
              {tag}
              <button onClick={() => remove(tag)} className="hover:text-red-400 leading-none w-3.5 h-3.5 flex items-center justify-center">×</button>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1 items-center">
        {available.map(tag => (
          <button key={tag} onClick={() => add(tag)}
            className="text-[10px] px-2 py-0.5 rounded-full border border-[#2a2a2a] text-[#444] hover:border-[#3a3a3a] hover:text-[#777] transition-colors">
            {tag}
          </button>
        ))}
        <input
          value={newTag}
          onChange={e => setNewTag(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(newTag) } }}
          placeholder="+ tag"
          className="text-[10px] px-2 py-0.5 rounded-full border border-dashed border-[#2a2a2a] bg-transparent text-[#555] placeholder-[#333] focus:outline-none focus:border-[#444] w-14"
        />
      </div>
    </div>
  )
}

export default function ContentBank({ username }: { username: string }) {
  const [pipelineModelId, setPipelineModelId] = useState<string | null>(null)
  const [items, setItems] = useState<ContentBankItem[]>([])
  const [loading, setLoading] = useState(true)
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null)
  const [uploadErrors, setUploadErrors] = useState<string[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [savingTagsId, setSavingTagsId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({})
  const [presetTags, setPresetTags] = useState<string[]>([])
  const [newPresetTag, setNewPresetTag] = useState('')
  const dragCounter = useRef(0)

  useEffect(() => {
    fetch('/api/settings/content-tags').then(r => r.json()).then(d => setPresetTags(d.tags ?? []))
  }, [])

  async function savePresetTags(tags: string[]) {
    setPresetTags(tags)
    await fetch('/api/settings/content-tags', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags }),
    })
  }

  function addPresetTag() {
    const t = newPresetTag.trim().toLowerCase()
    if (!t || presetTags.includes(t)) return
    setNewPresetTag('')
    savePresetTags([...presetTags, t])
  }

  function removePresetTag(tag: string) {
    savePresetTags(presetTags.filter(t => t !== tag))
  }

  const fetchItems = useCallback(async () => {
    const res = await fetch(`/api/pipeline/models/${username}`)
    if (res.ok) {
      const data = await res.json()
      setPipelineModelId(data.model?.id ?? null)
      const bank: ContentBankItem[] = (data.model?.content_bank ?? [])
        .filter((i: { type: string }) => i.type === 'own_footage')
        .sort((a: ContentBankItem, b: ContentBankItem) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      setItems(bank)
    }
    setLoading(false)
  }, [username])

  useEffect(() => { fetchItems() }, [fetchItems])

  async function uploadFile(file: File, modelId: string): Promise<string | null> {
    const res = await fetch('/api/pipeline/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: modelId, type: 'own_footage', filename: file.name, label: null, trim_start: 0, trim_end: null }),
    })
    if (!res.ok) return `${file.name}: failed to get upload URL`
    const { uploadUrl } = await res.json()
    const put = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'video/mp4' } })
    if (!put.ok) return `${file.name}: upload failed`
    return null
  }

  async function handleFiles(files: File[]) {
    if (!pipelineModelId || files.length === 0) return
    const videos = files.filter(f => f.type.startsWith('video/') || f.name.match(/\.(mp4|mov|webm|avi|mkv)$/i))
    if (videos.length === 0) return

    setUploadErrors([])
    setUploadProgress({ done: 0, total: videos.length })

    const errors: string[] = []
    await Promise.all(videos.map(async (file) => {
      const err = await uploadFile(file, pipelineModelId)
      if (err) errors.push(err)
      setUploadProgress(prev => prev ? { ...prev, done: prev.done + 1 } : null)
    }))

    setUploadProgress(null)
    if (errors.length) setUploadErrors(errors)
    fetchItems()
  }

  function onDragEnter(e: React.DragEvent) {
    e.preventDefault()
    dragCounter.current++
    if (dragCounter.current === 1) setDragActive(true)
  }

  function onDragLeave(e: React.DragEvent) {
    e.preventDefault()
    dragCounter.current--
    if (dragCounter.current === 0) setDragActive(false)
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault()
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    dragCounter.current = 0
    setDragActive(false)
    const files = Array.from(e.dataTransfer.files)
    handleFiles(files)
  }

  async function handleDelete(id: string) {
    if (!pipelineModelId) return
    setDeletingId(id)
    await fetch(`/api/pipeline/content-bank/${pipelineModelId}?id=${id}`, { method: 'DELETE' })
    setDeletingId(null)
    setItems(prev => prev.filter(i => i.id !== id))
  }

  async function togglePreview(item: ContentBankItem) {
    if (expandedId === item.id) { setExpandedId(null); return }
    setExpandedId(item.id)
    if (!signedUrls[item.id] && pipelineModelId) {
      const res = await fetch(`/api/pipeline/content-bank/${pipelineModelId}?signed=${item.id}`)
      if (res.ok) {
        const data = await res.json()
        setSignedUrls(prev => ({ ...prev, [item.id]: data.url }))
      }
    }
  }

  async function handleTagsChange(item: ContentBankItem, newTags: string[]) {
    if (!pipelineModelId) return
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, tags: newTags } : i))
    setSavingTagsId(item.id)
    await fetch(`/api/pipeline/content-bank/${pipelineModelId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, tags: newTags }),
    })
    setSavingTagsId(null)
  }

  const isUploading = uploadProgress !== null

  if (loading) return <p className="text-xs text-[#444]">Loading...</p>

  return (
    <div className="space-y-4">
      {/* Tag library */}
      <div className="space-y-2">
        <p className="text-[10px] text-[#444] uppercase tracking-wider">Tag library</p>
        <div className="flex flex-wrap gap-1.5 items-center">
          {presetTags.map(tag => (
            <span key={tag} className="flex items-center gap-1 text-[10px] pl-2 pr-1 py-0.5 rounded-full border border-[#2a2a2a] text-[#777]">
              {tag}
              <button onClick={() => removePresetTag(tag)} className="text-[#444] hover:text-red-400 leading-none w-3.5 h-3.5 flex items-center justify-center transition-colors">×</button>
            </span>
          ))}
          <input
            value={newPresetTag}
            onChange={e => setNewPresetTag(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPresetTag() } }}
            placeholder="+ new tag"
            className="text-[10px] px-2 py-0.5 rounded-full border border-dashed border-[#2a2a2a] bg-transparent text-[#555] placeholder-[#333] focus:outline-none focus:border-[#444] w-20"
          />
        </div>
      </div>

      {!pipelineModelId ? <p className="text-xs text-[#444]">Videos not available for this model.</p> : (<>
      {/* Upload zone */}
      <label
        className={`flex flex-col items-center justify-center border-2 border-dashed rounded-lg py-6 transition-colors cursor-pointer
          ${isUploading ? 'pointer-events-none opacity-50 border-[#2a2a2a]' : dragActive ? 'border-violet-500 bg-violet-500/5' : 'border-[#2a2a2a] hover:border-[#3a3a3a]'}`}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        {isUploading ? (
          <>
            <span className="text-xs text-[#555]">Uploading {uploadProgress!.done}/{uploadProgress!.total}...</span>
            <div className="mt-2 w-32 h-0.5 bg-[#1a1a1a] rounded-full overflow-hidden">
              <div
                className="h-full bg-violet-500 transition-all duration-300"
                style={{ width: `${(uploadProgress!.done / uploadProgress!.total) * 100}%` }}
              />
            </div>
          </>
        ) : (
          <>
            <span className="text-xs text-[#555] pointer-events-none">
              {dragActive ? 'Drop to upload' : 'Drop videos here or click to browse'}
            </span>
            <span className="text-[10px] text-[#333] pointer-events-none mt-0.5">Pre-trim on iPhone first (Photos app) — multiple files supported</span>
          </>
        )}
        <input
          type="file"
          accept="video/*"
          multiple
          className="hidden"
          disabled={isUploading}
          onChange={e => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            handleFiles(files)
          }}
        />
      </label>

      {uploadErrors.length > 0 && (
        <div className="space-y-0.5">
          {uploadErrors.map((err, i) => <p key={i} className="text-xs text-red-400">{err}</p>)}
        </div>
      )}

      {/* Video list */}
      {items.length === 0 && <p className="text-xs text-[#444]">No videos uploaded yet</p>}
      <div className="space-y-3">
        {items.map((item, idx) => (
          <div key={item.id} className="bg-[#0a0a0a] border border-[#1e1e1e] rounded-lg overflow-hidden">
            <div className="flex items-center gap-3 px-3 py-2.5">
              <button onClick={() => togglePreview(item)}
                className="flex items-center gap-2 min-w-0 flex-1 text-left group">
                <span className="text-xs font-mono text-[#555] flex-shrink-0">#{idx + 1}</span>
                {item.trim_end != null && (
                  <span className="text-[10px] text-[#444] flex-shrink-0">{(item.trim_end - item.trim_start).toFixed(1)}s</span>
                )}
                <span className={`text-[10px] flex-shrink-0 transition-colors ${expandedId === item.id ? 'text-violet-400' : 'text-[#333] group-hover:text-[#555]'}`}>
                  {expandedId === item.id ? '▲ hide' : '▶ preview'}
                </span>
                {savingTagsId === item.id && <span className="text-[10px] text-[#444] flex-shrink-0">saving...</span>}
              </button>
              <button onClick={() => handleDelete(item.id)} disabled={deletingId === item.id}
                className="text-xs text-[#444] hover:text-red-400 disabled:opacity-50 transition-colors flex-shrink-0">
                {deletingId === item.id ? '...' : 'Delete'}
              </button>
            </div>

            {expandedId === item.id && (
              <div className="px-3 pb-3">
                {signedUrls[item.id] ? (
                  <video src={signedUrls[item.id]} controls className="w-full max-h-72 rounded-lg bg-black object-contain" />
                ) : (
                  <div className="flex items-center justify-center h-24 text-xs text-[#444]">Loading...</div>
                )}
              </div>
            )}

            <div className="px-3 pb-3">
              <TagChips tags={item.tags ?? []} presetTags={presetTags} onChange={newTags => handleTagsChange(item, newTags)} />
            </div>
          </div>
        ))}
      </div>
      </>)}
    </div>
  )
}
