'use client'
// Video Templates (Wave B): upload CapCut exports directly to R2 (presigned PUT — Vercel's
// 4.5MB body cap forbids proxying), tag their applicability, and track draft→live status.
// Draft→manifest conversion is done by Claude per template.
import { useState, useEffect, useCallback } from 'react'

interface VideoTemplate {
  id: string
  name: string
  kind: 'caption' | 'meme' | 'overlay'
  status: 'draft' | 'live'
  content_tags: string[]
  weight: number
  created_at: string
  source_url: string | null
  preview_url: string | null
  manifest: unknown | null
}

const KINDS = ['caption', 'meme', 'overlay'] as const

export default function VideoTemplates({ contentTags }: { contentTags: string[] }) {
  const [templates, setTemplates] = useState<VideoTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<(typeof KINDS)[number]>('caption')
  const [tags, setTags] = useState<string[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const fetchTemplates = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/video-templates')
    if (res.ok) {
      const data = await res.json()
      setTemplates(data.templates ?? [])
    }
    setLoading(false)
  }, [])

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
        body: JSON.stringify({ name: name.trim(), kind, content_tags: tags, filename: file?.name ?? null }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'create failed')
      const { uploadUrl } = await res.json()
      if (file && uploadUrl) {
        const put = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'video/mp4' } })
        if (!put.ok) throw new Error(`upload failed (${put.status}) — check R2 CORS`)
      }
      setShowForm(false)
      setName('')
      setTags([])
      setFile(null)
      await fetchTemplates()
    } catch (err) {
      setUploadError((err as Error).message)
    } finally {
      setUploading(false)
    }
  }

  async function deleteTemplate(id: string) {
    setDeletingId(id)
    await fetch(`/api/video-templates/${id}`, { method: 'DELETE' })
    setTemplates(prev => prev.filter(t => t.id !== id))
    setDeletingId(null)
  }

  return (
    <div className="px-6 py-5 space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[#555]">
          Upload a template saved from CapCut — Claude rebuilds it as a render layout. Tags limit which
          videos can use it (no tags = any video).
        </p>
        <button
          onClick={() => setShowForm(true)}
          className="bg-white text-black text-xs font-medium px-4 py-2 rounded-lg hover:bg-[#e5e5e5] transition-colors flex-shrink-0"
        >
          + Upload template
        </button>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-[#111] border border-[#2a2a2a] rounded-2xl p-6 w-full max-w-sm">
            <h3 className="text-sm font-semibold mb-4">Upload Video Template</h3>
            <form onSubmit={handleUpload} className="space-y-3">
              <div>
                <label className="text-xs text-[#666] block mb-1">Name</label>
                <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Bear trap meme"
                  className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2.5 text-sm text-white placeholder-[#444] focus:outline-none focus:border-[#444]" />
              </div>
              <div>
                <label className="text-xs text-[#666] block mb-1">Kind</label>
                <div className="flex gap-2">
                  {KINDS.map(k => (
                    <button key={k} type="button" onClick={() => setKind(k)}
                      className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${kind === k ? 'bg-white text-black border-white' : 'border-[#2a2a2a] text-[#666] hover:text-white'}`}>
                      {k}
                    </button>
                  ))}
                </div>
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
                <label className="text-xs text-[#666] block mb-1">CapCut export (.mp4/.mov)</label>
                <input type="file" accept="video/mp4,video/quicktime" onChange={e => setFile(e.target.files?.[0] ?? null)}
                  className="w-full text-xs text-[#888] file:bg-[#1a1a1a] file:border-0 file:text-[#888] file:text-xs file:px-3 file:py-1.5 file:rounded-lg file:mr-3" />
              </div>
              {uploadError && <p className="text-xs text-red-400">{uploadError}</p>}
              <div className="flex gap-2 pt-1">
                <button type="submit" disabled={uploading || !name.trim()}
                  className="flex-1 bg-white text-black text-xs font-medium py-2.5 rounded-lg hover:bg-[#e5e5e5] disabled:opacity-50 transition-colors">
                  {uploading ? 'Uploading…' : 'Upload'}
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

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-5 h-5 border-2 border-[#333] border-t-white rounded-full animate-spin" />
        </div>
      ) : templates.length === 0 ? (
        <div className="text-center py-16 text-[#444]">
          <p className="text-sm">No video templates yet</p>
          <p className="text-xs mt-1">Save a template from the CapCut app and upload it here</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {templates.map(t => (
            <div key={t.id} className="bg-[#111] border border-[#1e1e1e] rounded-xl overflow-hidden">
              <div className="aspect-[9/16] bg-black max-h-72">
                {t.source_url ? (
                  <video src={t.source_url} muted loop playsInline controls className="w-full h-full object-contain" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[#333] text-xs">manifest-only</div>
                )}
              </div>
              <div className="p-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-white truncate">{t.name}</p>
                  <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${t.status === 'live' ? 'bg-green-500/15 text-green-400' : 'bg-amber-500/15 text-amber-400'}`}>
                    {t.status}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-[#555]">{t.kind} · {t.content_tags.length ? t.content_tags.join(', ') : 'any video'}</p>
                  <button onClick={() => deleteTemplate(t.id)} disabled={deletingId === t.id}
                    className="text-[10px] text-[#333] hover:text-red-400 disabled:opacity-40 transition-colors">
                    {deletingId === t.id ? '…' : '×'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
