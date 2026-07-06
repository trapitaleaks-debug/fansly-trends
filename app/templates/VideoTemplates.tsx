'use client'
// Memes + Styles tabs (Templates v2). Upload CapCut exports direct to R2 (presigned PUT),
// edit targeting (content tags + niches) and template text, toggle draft/live, duplicate,
// and render a demo preview so you see exactly what each template produces.
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNiches } from '@/components/NichesProvider'

interface VideoTemplate {
  id: string
  name: string
  kind: 'caption' | 'meme' | 'overlay'
  status: 'draft' | 'live'
  content_tags: string[]
  niches: string[]
  weight: number
  created_at: string
  source_url: string | null
  preview_url: string | null
  manifest: unknown | null
}

export default function VideoTemplates({ contentTags, kinds }: { contentTags: string[]; kinds: string[] }) {
  const { niches: nicheDefs } = useNiches()
  const allNiches = useMemo(() => nicheDefs.map(n => n.name), [nicheDefs])
  const isStylesTab = kinds.includes('caption')

  const [templates, setTemplates] = useState<VideoTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<VideoTemplate | null>(null)
  const [editTags, setEditTags] = useState<string[]>([])
  const [editNiches, setEditNiches] = useState<string[]>([])
  const [editLines, setEditLines] = useState('')
  const [saving, setSaving] = useState(false)
  const [previewNote, setPreviewNote] = useState<string | null>(null)

  const fetchTemplates = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/video-templates')
    if (res.ok) {
      const data = await res.json()
      setTemplates(((data.templates ?? []) as VideoTemplate[]).filter(t => kinds.includes(t.kind)))
    }
    setLoading(false)
  }, [kinds])
  useEffect(() => { fetchTemplates() }, [fetchTemplates])

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setUploading(true)
    setUploadError(null)
    try {
      const res = await fetch('/api/video-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), kind: isStylesTab ? 'caption' : 'meme', content_tags: tags, filename: file?.name ?? null }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'create failed')
      const { uploadUrl } = await res.json()
      if (file && uploadUrl) {
        const put = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'video/mp4' } })
        if (!put.ok) throw new Error(`upload failed (${put.status}) — check R2 CORS`)
      }
      setShowForm(false); setName(''); setTags([]); setFile(null)
      await fetchTemplates()
    } catch (err) {
      setUploadError((err as Error).message)
    } finally {
      setUploading(false)
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setBusyId(id)
    await fetch(`/api/video-templates/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    setBusyId(null)
    await fetchTemplates()
  }

  async function duplicate(id: string) {
    setBusyId(id)
    await fetch(`/api/video-templates/${id}/duplicate`, { method: 'POST' })
    setBusyId(null)
    await fetchTemplates()
  }

  async function deleteTemplate(id: string) {
    if (!confirm('Delete this template? Jobs using it fall back to the classic look.')) return
    setBusyId(id)
    await fetch(`/api/video-templates/${id}`, { method: 'DELETE' })
    setTemplates(prev => prev.filter(t => t.id !== id))
    setBusyId(null)
  }

  async function renderPreview(id: string) {
    setBusyId(id)
    setPreviewNote('Rendering preview (~30s)… refresh in a moment')
    await fetch(`/api/video-templates/${id}/preview`, { method: 'POST' }).catch(() => {})
    setBusyId(null)
    setTimeout(() => { fetchTemplates(); setPreviewNote(null) }, 45_000)
  }

  function openEdit(t: VideoTemplate) {
    setEditing(t)
    setEditTags(t.content_tags)
    setEditNiches(t.niches ?? [])
    const m = (t.manifest ?? {}) as { fixed_lines?: string[] }
    setEditLines((m.fixed_lines ?? []).join('\n'))
  }

  async function saveEdit() {
    if (!editing) return
    setSaving(true)
    const manifest = { ...((editing.manifest ?? {}) as Record<string, unknown>) }
    if ('fixed_lines' in manifest || editLines.trim().length > 0 || editing.kind !== 'caption') {
      manifest.fixed_lines = editLines.split('\n').map(s => s.trim()).filter(Boolean)
    }
    await fetch(`/api/video-templates/${editing.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_tags: editTags, niches: editNiches, manifest }),
    })
    setSaving(false)
    setEditing(null)
    await fetchTemplates()
  }

  return (
    <div className="px-6 py-5 space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[#555]">
          {isStylesTab
            ? 'Styles dress caption videos. Empty tags/niches = applies to anyone.'
            : 'Save a template from CapCut, upload it here — Claude rebuilds it as a render layout.'}
          {previewNote && <span className="text-violet-300 ml-2">{previewNote}</span>}
        </p>
        <button onClick={() => setShowForm(true)}
          className="bg-white text-black text-xs font-medium px-4 py-2 rounded-lg hover:bg-[#e5e5e5] transition-colors flex-shrink-0">
          {isStylesTab ? '+ New style (upload reference)' : '+ Upload template'}
        </button>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-[#111] border border-[#2a2a2a] rounded-2xl p-6 w-full max-w-sm">
            <h3 className="text-sm font-semibold mb-4">{isStylesTab ? 'New Style' : 'Upload Video Template'}</h3>
            <form onSubmit={handleUpload} className="space-y-3">
              <div>
                <label className="text-xs text-[#666] block mb-1">Name</label>
                <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={isStylesTab ? 'e.g. Neon Glow' : 'e.g. Bear trap meme'}
                  className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2.5 text-sm text-white placeholder-[#444] focus:outline-none focus:border-[#444]" />
              </div>
              <div>
                <label className="text-xs text-[#666] block mb-1">Content tags (empty = any video)</label>
                <div className="flex flex-wrap gap-1.5">
                  {contentTags.map(tag => (
                    <button key={tag} type="button"
                      onClick={() => setTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag])}
                      className={`text-[11px] px-2 py-1 rounded border transition-colors ${tags.includes(tag) ? 'bg-violet-500/20 border-violet-500/50 text-violet-300' : 'border-[#2a2a2a] text-[#555] hover:text-white'}`}>
                      {tag}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-[#666] block mb-1">Reference video (.mp4/.mov{isStylesTab ? ', optional' : ''})</label>
                <input type="file" accept="video/mp4,video/quicktime" onChange={e => setFile(e.target.files?.[0] ?? null)}
                  className="w-full text-xs text-[#888] file:bg-[#1a1a1a] file:border-0 file:text-[#888] file:text-xs file:px-3 file:py-1.5 file:rounded-lg file:mr-3" />
              </div>
              {uploadError && <p className="text-xs text-red-400">{uploadError}</p>}
              <div className="flex gap-2 pt-1">
                <button type="submit" disabled={uploading || !name.trim()}
                  className="flex-1 bg-white text-black text-xs font-medium py-2.5 rounded-lg hover:bg-[#e5e5e5] disabled:opacity-50 transition-colors">
                  {uploading ? 'Uploading…' : 'Create'}
                </button>
                <button type="button" onClick={() => { setShowForm(false); setUploadError(null) }}
                  className="flex-1 bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] text-xs py-2.5 rounded-lg hover:text-white transition-colors">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-[#111] border border-[#2a2a2a] rounded-2xl p-6 w-full max-w-sm space-y-3">
            <h3 className="text-sm font-semibold">Edit — {editing.name}</h3>
            <div>
              <label className="text-xs text-[#666] block mb-1">Content tags (empty = any video)</label>
              <div className="flex flex-wrap gap-1.5">
                {contentTags.map(tag => (
                  <button key={tag} type="button"
                    onClick={() => setEditTags(prev => prev.includes(tag) ? prev.filter(x => x !== tag) : [...prev, tag])}
                    className={`text-[11px] px-2 py-1 rounded border transition-colors ${editTags.includes(tag) ? 'bg-violet-500/20 border-violet-500/50 text-violet-300' : 'border-[#2a2a2a] text-[#555] hover:text-white'}`}>
                    {tag}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-[#666] block mb-1">Niches (empty = all models)</label>
              <div className="flex flex-wrap gap-1.5">
                {allNiches.map(n => (
                  <button key={n} type="button"
                    onClick={() => setEditNiches(prev => prev.includes(n) ? prev.filter(x => x !== n) : [...prev, n])}
                    className={`text-[11px] px-2 py-1 rounded border transition-colors ${editNiches.includes(n) ? 'bg-sky-500/20 border-sky-500/50 text-sky-300' : 'border-[#2a2a2a] text-[#555] hover:text-white'}`}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-[#666] block mb-1">
                Template text — one line per row, [placeholder] swapped per model. Empty = no text.
              </label>
              <textarea value={editLines} onChange={e => setEditLines(e.target.value)} rows={4}
                placeholder={'e.g. POV: when [placeholder] happens'}
                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2.5 text-xs text-white placeholder-[#444] focus:outline-none focus:border-[#444] font-mono" />
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={saveEdit} disabled={saving}
                className="flex-1 bg-white text-black text-xs font-medium py-2.5 rounded-lg hover:bg-[#e5e5e5] disabled:opacity-50 transition-colors">
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => setEditing(null)}
                className="flex-1 bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] text-xs py-2.5 rounded-lg hover:text-white transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-5 h-5 border-2 border-[#333] border-t-white rounded-full animate-spin" />
        </div>
      ) : templates.length === 0 ? (
        <div className="text-center py-16 text-[#444]">
          <p className="text-sm">Nothing here yet</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {templates.map(t => (
            <div key={t.id} className="bg-[#111] border border-[#1e1e1e] rounded-xl overflow-hidden">
              <div className="aspect-[9/16] bg-black max-h-72">
                {(t.preview_url || t.source_url) ? (
                  <video src={t.preview_url ?? t.source_url ?? undefined} muted loop playsInline controls className="w-full h-full object-contain" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[#333] text-xs">no preview yet</div>
                )}
              </div>
              <div className="p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-white truncate">{t.name}</p>
                  <button onClick={() => patch(t.id, { status: t.status === 'live' ? 'draft' : 'live' })} disabled={busyId === t.id}
                    className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded transition-colors ${t.status === 'live' ? 'bg-green-500/15 text-green-400 hover:bg-red-500/15 hover:text-red-400' : 'bg-amber-500/15 text-amber-400 hover:bg-green-500/15 hover:text-green-400'}`}
                    title={t.status === 'live' ? 'Click to pull offline' : 'Click to go live'}>
                    {t.status}
                  </button>
                </div>
                <p className="text-[10px] text-[#555] truncate">
                  {t.content_tags.length ? t.content_tags.join(', ') : 'any video'}
                  {' · '}
                  {t.niches?.length ? t.niches.join(', ') : 'all models'}
                </p>
                <div className="flex items-center gap-2 text-[10px]">
                  <button onClick={() => openEdit(t)} className="text-[#555] hover:text-white">Edit</button>
                  <button onClick={() => renderPreview(t.id)} disabled={busyId === t.id} className="text-[#555] hover:text-white disabled:opacity-40">Preview</button>
                  <button onClick={() => duplicate(t.id)} disabled={busyId === t.id} className="text-[#555] hover:text-white disabled:opacity-40">Duplicate</button>
                  <div className="flex-1" />
                  <button onClick={() => deleteTemplate(t.id)} disabled={busyId === t.id} className="text-[#333] hover:text-red-400 disabled:opacity-40">×</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
