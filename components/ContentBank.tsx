'use client'
import { useState, useEffect, useRef, useCallback } from 'react'

// Tags are managed via /api/settings/content-tags — not hardcoded here


export interface ContentBankItem {
  id: string
  r2_key: string
  label: string | null
  tags: string[]
  trim_start: number
  trim_end: number | null
  created_at: string
}

function TrimSelector({ file, onConfirm, onCancel, uploading, trimProgress }: {
  file: File
  onConfirm: (start: number, end: number) => void
  onCancel: () => void
  uploading: boolean
  trimProgress?: string | null
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [objectUrl, setObjectUrl] = useState('')
  const [videoDuration, setVideoDuration] = useState(0)
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0)

  useEffect(() => {
    const url = URL.createObjectURL(file)
    setObjectUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  function onLoaded() {
    const dur = videoRef.current?.duration ?? 0
    setVideoDuration(dur)
    setTrimEnd(Math.min(15, dur))
  }

  function updateStart(raw: number) {
    const start = Math.min(raw, videoDuration - 7)
    let end = trimEnd
    if (end < start + 7) end = start + 7
    if (end > start + 15) end = start + 15
    if (end > videoDuration) end = videoDuration
    setTrimStart(start); setTrimEnd(end)
    if (videoRef.current) videoRef.current.currentTime = start
  }

  function updateEnd(raw: number) {
    const end = Math.min(Math.max(raw, trimStart + 7), Math.min(trimStart + 15, videoDuration))
    setTrimEnd(end)
    if (videoRef.current) videoRef.current.currentTime = end
  }

  const selDuration = trimEnd - trimStart
  const valid = videoDuration > 0 && selDuration >= 7 && selDuration <= 15

  return (
    <div className="bg-[#0a0a0a] border border-[#1e1e1e] rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[#888]">Select 7–15 seconds to upload</p>
        <span className={`text-xs font-mono ${valid ? 'text-green-400' : 'text-yellow-400'}`}>
          {selDuration > 0 ? `${selDuration.toFixed(1)}s` : '—'}
        </span>
      </div>
      {objectUrl && <video ref={videoRef} src={objectUrl} className="w-full rounded-lg max-h-44 object-contain bg-black" onLoadedMetadata={onLoaded} muted controls />}
      {videoDuration > 0 && (
        <div className="space-y-3">
          <div className="relative h-5 bg-[#1a1a1a] rounded overflow-hidden">
            <div className="absolute inset-y-0 bg-violet-500/20 border-l-2 border-r-2 border-violet-500"
              style={{ left: `${(trimStart / videoDuration) * 100}%`, width: `${((trimEnd - trimStart) / videoDuration) * 100}%` }} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><p className="text-[10px] text-[#555] mb-1">Start: {trimStart.toFixed(1)}s</p>
              <input type="range" min={0} max={Math.max(0, videoDuration - 7)} step={0.1} value={trimStart} onChange={e => updateStart(parseFloat(e.target.value))} className="w-full accent-violet-500" />
            </div>
            <div><p className="text-[10px] text-[#555] mb-1">End: {trimEnd.toFixed(1)}s</p>
              <input type="range" min={Math.min(7, videoDuration)} max={videoDuration} step={0.1} value={trimEnd} onChange={e => updateEnd(parseFloat(e.target.value))} className="w-full accent-violet-500" />
            </div>
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <button onClick={() => onConfirm(trimStart, trimEnd)} disabled={!valid || uploading}
          className="flex-1 text-xs bg-white text-black px-3 py-2 rounded-lg hover:bg-[#e5e5e5] disabled:opacity-40 transition-colors">
          {trimProgress ?? (uploading ? 'Uploading...' : 'Confirm & Upload')}
        </button>
        <button onClick={onCancel} disabled={uploading} className="text-xs text-[#555] hover:text-white px-3 py-2 transition-colors disabled:opacity-40">Cancel</button>
      </div>
    </div>
  )
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

async function trimVideoClientSide(
  file: File,
  trimStart: number,
  trimEnd: number,
  onProgress: (msg: string) => void
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    const objectUrl = URL.createObjectURL(file)
    video.src = objectUrl
    video.preload = 'auto'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captureStreamFn = (video as any).captureStream?.bind(video) || (video as any).mozCaptureStream?.bind(video)
    if (!captureStreamFn) { URL.revokeObjectURL(objectUrl); reject(new Error('captureStream not supported in this browser')); return }

    video.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Video load error')) }
    video.onloadedmetadata = () => {
      // 10Mbps VP9 gives dramatically better quality than browser default (~1-2Mbps)
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
        .find(t => { try { return MediaRecorder.isTypeSupported(t) } catch { return false } }) ?? 'video/webm'
      const stream: MediaStream = captureStreamFn()
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 10_000_000 })
      const chunks: Blob[] = []
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
      recorder.onstop = () => {
        URL.revokeObjectURL(objectUrl)
        resolve(new Blob(chunks, { type: mimeType.split(';')[0] }))
      }
      video.currentTime = trimStart
      video.onseeked = () => {
        video.onseeked = null
        const duration = trimEnd - trimStart
        let remaining = Math.ceil(duration)
        onProgress(`Trimming... ${remaining}s`)
        const tick = setInterval(() => { remaining = Math.max(0, remaining - 1); onProgress(`Trimming... ${remaining}s`) }, 1000)
        recorder.start(250)
        video.play()
        const check = () => {
          if (video.currentTime >= trimEnd) { clearInterval(tick); video.pause(); recorder.stop() }
          else requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      }
    }
    video.load()
  })
}

export default function ContentBank({ username }: { username: string }) {
  const [pipelineModelId, setPipelineModelId] = useState<string | null>(null)
  const [items, setItems] = useState<ContentBankItem[]>([])
  const [loading, setLoading] = useState(true)
  const [file, setFile] = useState<File | null>(null)
  const [showTrim, setShowTrim] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [trimProgress, setTrimProgress] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [savingTagsId, setSavingTagsId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({})
  const [presetTags, setPresetTags] = useState<string[]>([])
  const [newPresetTag, setNewPresetTag] = useState('')

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
      // Filter to videos only (own_footage), sort ascending so #1 is oldest
      const bank: ContentBankItem[] = (data.model?.content_bank ?? [])
        .filter((i: { type: string }) => i.type === 'own_footage')
        .sort((a: ContentBankItem, b: ContentBankItem) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      setItems(bank)
    }
    setLoading(false)
  }, [username])

  useEffect(() => { fetchItems() }, [fetchItems])

  async function handleUpload(trimStart: number, trimEnd: number) {
    if (!file || !pipelineModelId) return
    setUploading(true)
    setUploadError(null)

    let blob: Blob
    try {
      blob = await trimVideoClientSide(file, trimStart, trimEnd, setTrimProgress)
    } catch (e) {
      setUploadError((e as Error).message)
      setUploading(false); setTrimProgress(null); return
    }

    setTrimProgress('Uploading...')
    const filename = file.name.replace(/\.[^.]+$/, '.webm')
    // File is pre-trimmed; store trim_start=0, trim_end=null so ffmpeg uses full file
    const res = await fetch('/api/pipeline/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: pipelineModelId, type: 'own_footage', filename, label: null, trim_start: 0, trim_end: null }),
    })
    if (!res.ok) { setUploadError('Failed to get upload URL'); setUploading(false); setTrimProgress(null); return }
    const { uploadUrl } = await res.json()

    const xhr = new XMLHttpRequest()
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100)
        setTrimProgress(`Uploading... ${pct}%`)
      }
    }
    await new Promise<void>((resolve, reject) => {
      xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) resolve(); else reject(new Error(`Upload failed: ${xhr.status}`)) }
      xhr.onerror = () => reject(new Error('Upload network error'))
      xhr.open('PUT', uploadUrl)
      xhr.setRequestHeader('Content-Type', 'video/webm')
      xhr.send(blob)
    }).catch(e => { setUploadError((e as Error).message); setUploading(false); setTrimProgress(null) })

    setUploading(false)
    setTrimProgress(null)
    setFile(null); setShowTrim(false)
    fetchItems()
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
    // optimistic
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, tags: newTags } : i))
    setSavingTagsId(item.id)
    await fetch(`/api/pipeline/content-bank/${pipelineModelId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, tags: newTags }),
    })
    setSavingTagsId(null)
  }

  if (loading) return <p className="text-xs text-[#444]">Loading...</p>

  return (
    <div className="space-y-4">
      {/* Tag library — always visible */}
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
      {showTrim && file ? (
        <TrimSelector file={file} onConfirm={handleUpload} onCancel={() => { setShowTrim(false); setFile(null) }} uploading={uploading} trimProgress={trimProgress} />
      ) : (
        <label className="flex items-center justify-center border-2 border-dashed border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg py-5 cursor-pointer transition-colors">
          <span className="text-xs text-[#555] hover:text-[#888] pointer-events-none">Click to add a video — you&apos;ll trim it before uploading</span>
          <input type="file" accept="video/*" className="hidden" onChange={e => {
            const f = e.target.files?.[0]; e.target.value = ''
            if (!f) return
            setFile(f); setUploadError(null); setShowTrim(true)
          }} />
        </label>
      )}
      {uploadError && <p className="text-xs text-red-400">{uploadError}</p>}

      {/* Video list */}
      {items.length === 0 && !showTrim && <p className="text-xs text-[#444]">No videos uploaded yet</p>}
      <div className="space-y-3">
        {items.map((item, idx) => (
          <div key={item.id} className="bg-[#0a0a0a] border border-[#1e1e1e] rounded-lg overflow-hidden">
            {/* Row header */}
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

            {/* Inline video preview */}
            {expandedId === item.id && (
              <div className="px-3 pb-3">
                {signedUrls[item.id] ? (
                  <video src={signedUrls[item.id]} controls className="w-full max-h-72 rounded-lg bg-black object-contain" />
                ) : (
                  <div className="flex items-center justify-center h-24 text-xs text-[#444]">Loading...</div>
                )}
              </div>
            )}

            {/* Tags */}
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
