'use client'
import { useState, useEffect, useRef, useCallback, use } from 'react'
import Link from 'next/link'

async function trimVideoClientSide(
  file: File,
  trimStart: number,
  trimEnd: number,
  onProgress: (msg: string) => void
): Promise<{ blob: Blob; filename: string }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    const objectUrl = URL.createObjectURL(file)
    video.src = objectUrl
    video.preload = 'auto'

    video.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Video failed to load')) }

    video.onloadedmetadata = () => {
      const captureStream = (video as any).captureStream?.bind(video) || (video as any).mozCaptureStream?.bind(video)
      if (!captureStream) { URL.revokeObjectURL(objectUrl); reject(new Error('captureStream not supported')); return }

      const stream: MediaStream = captureStream()
      const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
        .find(t => { try { return MediaRecorder.isTypeSupported(t) } catch { return false } }) ?? 'video/webm'

      const recorder = new MediaRecorder(stream, { mimeType })
      const chunks: Blob[] = []
      recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
      recorder.onstop = () => {
        URL.revokeObjectURL(objectUrl)
        const type = mimeType.split(';')[0]
        const blob = new Blob(chunks, { type })
        const ext = type === 'video/mp4' ? 'mp4' : 'webm'
        resolve({ blob, filename: file.name.replace(/\.[^.]+$/, `.${ext}`) })
      }

      video.currentTime = trimStart
      video.onseeked = () => {
        video.onseeked = null
        const duration = trimEnd - trimStart
        let remaining = Math.ceil(duration)
        onProgress(`Recording clip... ${remaining}s`)
        const tick = setInterval(() => {
          remaining = Math.max(0, remaining - 1)
          onProgress(`Recording clip... ${remaining}s`)
        }, 1000)
        recorder.start(250)
        video.play()
        const check = () => {
          if (video.currentTime >= trimEnd) {
            clearInterval(tick)
            video.pause()
            recorder.stop()
          } else {
            requestAnimationFrame(check)
          }
        }
        requestAnimationFrame(check)
      }
    }

    video.load()
  })
}

interface ContentBankItem {
  id: string
  type: 'own_footage' | 'hook_clip' | 'audio'
  r2_key: string
  label: string
  trim_start: number
  trim_end: number | null
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
  character_sheet_signed_url: string | null
  pinned_character_sheet_key: string | null
  sheet_status: string | null
  content_bank: ContentBankItem[]
}


function TrimSelector({
  file, label, onLabelChange, onConfirm, onCancel, uploading, trimProgress,
}: {
  file: File
  label: string
  onLabelChange: (v: string) => void
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
    setTrimStart(start)
    setTrimEnd(end)
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
        <span className={`text-xs font-mono tabular-nums ${valid ? 'text-green-400' : 'text-yellow-400'}`}>
          {selDuration > 0 ? `${selDuration.toFixed(1)}s` : '—'}
        </span>
      </div>

      {objectUrl && (
        <video
          ref={videoRef}
          src={objectUrl}
          className="w-full rounded-lg max-h-44 object-contain bg-black"
          onLoadedMetadata={onLoaded}
          muted
          controls
        />
      )}

      {videoDuration > 0 && (
        <>
          {/* Timeline bar */}
          <div className="relative h-6 bg-[#1a1a1a] rounded-md overflow-hidden select-none">
            <div
              className="absolute inset-y-0 bg-violet-500/20 border-l-2 border-r-2 border-violet-500"
              style={{
                left: `${(trimStart / videoDuration) * 100}%`,
                width: `${((trimEnd - trimStart) / videoDuration) * 100}%`,
              }}
            />
            <div className="absolute inset-0 flex items-center justify-between px-2 pointer-events-none">
              <span className="text-[10px] text-violet-400">{trimStart.toFixed(1)}s</span>
              <span className="text-[10px] text-violet-400">{trimEnd.toFixed(1)}s</span>
            </div>
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-[10px] text-[#555]">Start: {trimStart.toFixed(1)}s</p>
              <input
                type="range" min={0} max={Math.max(0, videoDuration - 7)} step={0.1} value={trimStart}
                onChange={e => updateStart(parseFloat(e.target.value))}
                className="w-full accent-violet-500 cursor-pointer"
              />
            </div>
            <div className="space-y-1">
              <p className="text-[10px] text-[#555]">End: {trimEnd.toFixed(1)}s</p>
              <input
                type="range" min={Math.min(7, videoDuration)} max={videoDuration} step={0.1} value={trimEnd}
                onChange={e => updateEnd(parseFloat(e.target.value))}
                className="w-full accent-violet-500 cursor-pointer"
              />
            </div>
          </div>
        </>
      )}

      <input
        value={label}
        onChange={e => onLabelChange(e.target.value)}
        placeholder={`Label (default: ${file.name})`}
        className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-xs text-white placeholder-[#444] focus:outline-none focus:border-[#444]"
      />

      <div className="flex gap-2">
        <button
          onClick={() => onConfirm(trimStart, trimEnd)}
          disabled={!valid || uploading}
          className="flex-1 text-xs bg-white text-black px-3 py-2 rounded-lg hover:bg-[#e5e5e5] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {trimProgress ?? (uploading ? 'Uploading...' : 'Confirm & Upload')}
        </button>
        <button
          onClick={onCancel}
          disabled={uploading}
          className="text-xs text-[#555] hover:text-white px-3 py-2 transition-colors disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    </div>
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
  const [trimProgress, setTrimProgress] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [showTrim, setShowTrim] = useState(false)

  const isVideo = type === 'own_footage' || type === 'hook_clip'
  const typeItems = items.filter(i => i.type === type)

  async function handleUpload(trimStart = 0, trimEnd: number | null = null) {
    if (!file) return
    setUploading(true)
    setUploadError(null)
    setTrimProgress(null)

    let uploadFile: File | Blob = file
    let uploadFilename = file.name

    if (isVideo && trimEnd != null) {
      try {
        const trimmed = await trimVideoClientSide(file, trimStart, trimEnd, msg => setTrimProgress(msg))
        uploadFile = trimmed.blob
        uploadFilename = trimmed.filename
      } catch (e) {
        setUploadError((e as Error).message || 'Video trimming failed')
        setUploading(false)
        setTrimProgress(null)
        return
      }
      setTrimProgress(null)
    }

    const res = await fetch('/api/pipeline/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_id: modelId,
        type,
        filename: uploadFilename,
        label: fileLabel || file.name,
        trim_start: trimStart,
        trim_end: trimEnd,
      }),
    })

    if (!res.ok) {
      const data = await res.json()
      setUploadError(data.error ?? 'Failed to get upload URL')
      setUploading(false)
      return
    }

    const { uploadUrl, contentType: ct } = await res.json()

    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      body: uploadFile,
      headers: { 'Content-Type': ct || (uploadFile as File).type || 'application/octet-stream' },
    })

    setUploading(false)

    if (!putRes.ok) {
      setUploadError('Upload to storage failed')
      return
    }

    setFile(null)
    setFileLabel('')
    setShowTrim(false)
    onUploaded()
  }

  async function handleDelete(itemId: string) {
    setDeletingId(itemId)
    await fetch(`/api/pipeline/content-bank/${modelId}?id=${itemId}`, { method: 'DELETE' })
    setDeletingId(null)
    onDelete(itemId)
  }

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-medium text-[#888]">{sectionLabel}</h4>

      {showTrim && file ? (
        <TrimSelector
          file={file}
          label={fileLabel}
          onLabelChange={setFileLabel}
          onConfirm={handleUpload}
          onCancel={() => { setShowTrim(false); setFile(null); setFileLabel('') }}
          uploading={uploading}
          trimProgress={trimProgress}
        />
      ) : isVideo ? (
        <label className="flex items-center justify-center border-2 border-dashed border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg py-5 cursor-pointer transition-colors">
          <span className="text-xs text-[#555] hover:text-[#888] pointer-events-none">Click to select a video — you'll trim it before uploading</span>
          <input
            type="file"
            accept={accept}
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              setFile(f)
              setFileLabel('')
              setUploadError(null)
              setShowTrim(true)
            }}
          />
        </label>
      ) : (
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
              onClick={() => handleUpload()}
              disabled={!file || uploading}
              className="text-xs bg-white text-black px-3 py-2 rounded-lg hover:bg-[#e5e5e5] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
            >
              {uploading ? 'Uploading...' : 'Upload'}
            </button>
          </div>
          {uploadError && <p className="text-xs text-red-400">{uploadError}</p>}
        </div>
      )}

      {uploadError && showTrim && <p className="text-xs text-red-400">{uploadError}</p>}

      {typeItems.length > 0 ? (
        <div className="space-y-2">
          {typeItems.map(item => (
            <div
              key={item.id}
              className="flex items-center justify-between bg-[#0a0a0a] border border-[#1e1e1e] rounded-lg px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-xs text-[#ccc] truncate">{item.label}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <p className="text-[10px] text-[#444] truncate">{item.r2_key.split('/').pop()}</p>
                  {item.trim_end != null && (
                    <span className="text-[10px] text-violet-400 shrink-0">
                      {item.trim_start.toFixed(1)}s–{item.trim_end.toFixed(1)}s ({(item.trim_end - item.trim_start).toFixed(1)}s)
                    </span>
                  )}
                </div>
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
        !showTrim && <p className="text-xs text-[#444]">No files uploaded yet</p>
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
  const [notesForAi, setNotesForAi] = useState('')
  const [savingSettings, setSavingSettings] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)

  // Source photos
  const [sourcePhotos, setSourcePhotos] = useState<{ key: string; filename: string; signedUrl: string }[]>([])
  const [loadingPhotos, setLoadingPhotos] = useState(true)
  const [uploadingPhotos, setUploadingPhotos] = useState(false)
  const [uploadPhotoProgress, setUploadPhotoProgress] = useState('')
  const [selectedPhotoKeys, setSelectedPhotoKeys] = useState<Set<string>>(new Set())
  const [isDragOver, setIsDragOver] = useState(false)

  // Pin / generate character sheet
  const [pinning, setPinning] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [sheetQueuing, setSheetQueuing] = useState(false)

  const fetchSourcePhotos = useCallback(async () => {
    setLoadingPhotos(true)
    const res = await fetch(`/api/pipeline/models/${handle}/source-photos`)
    if (res.ok) {
      const data = await res.json()
      setSourcePhotos(data.photos ?? [])
    }
    setLoadingPhotos(false)
  }, [handle])

  const fetchModel = useCallback(async () => {
    const res = await fetch(`/api/pipeline/models/${handle}`)
    if (res.ok) {
      const data = await res.json()
      const m: PipelineModelDetail = { ...data.model, content_bank: data.model.content_bank ?? [] }
      setModel(m)
      setVideosPerCycle(m.videos_per_cycle)
      setNotesForAi(m.notes_for_ai ?? '')
      setPinned(!!m.pinned_character_sheet_key)
    }
    setLoading(false)
  }, [handle])

  useEffect(() => {
    fetchModel()
    fetchSourcePhotos()
  }, [fetchModel, fetchSourcePhotos])

  // Auto-refresh while sheet is generating
  useEffect(() => {
    if (!model?.sheet_status || model.sheet_status === 'error') return
    const interval = setInterval(fetchModel, 10_000)
    return () => clearInterval(interval)
  }, [model?.sheet_status, fetchModel])

  async function uploadPhotoFiles(files: File[]) {
    const imageFiles = files.filter(f => f.type.startsWith('image/'))
    if (!imageFiles.length) return
    setUploadingPhotos(true)
    setUploadPhotoProgress(`0 / ${imageFiles.length}`)

    // One API call → all presigned URLs at once (avoids browser per-origin connection limit)
    const res = await fetch(`/api/pipeline/models/${handle}/source-photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames: imageFiles.map(f => f.name) }),
    })
    if (!res.ok) { setUploadingPhotos(false); setUploadPhotoProgress(''); return }
    const { slots } = await res.json() as { slots: { uploadUrl: string; key: string; contentType: string }[] }

    // All PUTs fire simultaneously to R2 (different domain — no per-origin limit applies)
    let done = 0
    let failed = 0
    await Promise.allSettled(slots.map(async ({ uploadUrl, contentType }, i) => {
      try {
        const putRes = await fetch(uploadUrl, {
          method: 'PUT',
          body: imageFiles[i],
          headers: { 'Content-Type': contentType },
        })
        if (!putRes.ok) {
          console.error(`PUT failed ${putRes.status} for ${imageFiles[i].name}`)
          failed++
        }
      } catch (e) {
        console.error(`PUT threw for ${imageFiles[i].name}:`, e)
        failed++
      } finally {
        done++
        setUploadPhotoProgress(`${done} / ${imageFiles.length}`)
      }
    }))

    setUploadingPhotos(false)
    setUploadPhotoProgress('')
    if (failed > 0) console.warn(`${failed} uploads failed — check R2 CORS config`)
    fetchSourcePhotos()
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    uploadPhotoFiles(files)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragOver(false)
    uploadPhotoFiles(Array.from(e.dataTransfer.files))
  }

  function toggleSelectPhoto(key: string) {
    setSelectedPhotoKeys(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  async function handleDeleteSelected() {
    const keys = Array.from(selectedPhotoKeys)
    await Promise.all(keys.map(key =>
      fetch(`/api/pipeline/models/${handle}/source-photos?key=${encodeURIComponent(key)}`, { method: 'DELETE' })
    ))
    setSourcePhotos(prev => prev.filter(p => !selectedPhotoKeys.has(p.key)))
    setSelectedPhotoKeys(new Set())
  }

  async function handleDeleteSourcePhoto(key: string) {
    await fetch(`/api/pipeline/models/${handle}/source-photos?key=${encodeURIComponent(key)}`, { method: 'DELETE' })
    setSourcePhotos(prev => prev.filter(p => p.key !== key))
  }

  async function handleSaveSettings() {
    setSavingSettings(true)
    await fetch(`/api/pipeline/models/${handle}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videos_per_cycle: videosPerCycle,
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

  async function handleGenerateSheet() {
    setSheetQueuing(true)
    await fetch(`/api/pipeline/models/${handle}/generate-sheet`, { method: 'POST' })
    setSheetQueuing(false)
    setPinned(false)
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

        {/* Source Photos */}
        <div
          className={`bg-[#111] border rounded-xl p-6 space-y-4 transition-colors ${isDragOver ? 'border-violet-500/50 bg-violet-500/5' : 'border-[#1a1a1a]'}`}
          onDragOver={e => { e.preventDefault(); setIsDragOver(true) }}
          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false) }}
          onDrop={handleDrop}
        >
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <h3 className="text-sm font-medium">Source Photos</h3>
              <p className="text-xs text-[#444] mt-0.5">
                {loadingPhotos ? 'Loading...' : `${sourcePhotos.length} photo${sourcePhotos.length !== 1 ? 's' : ''} · 10+ recommended`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {selectedPhotoKeys.size > 0 && (
                <button
                  onClick={handleDeleteSelected}
                  className="text-xs text-red-400 border border-red-400/20 bg-red-400/5 hover:border-red-400/40 px-3 py-1.5 rounded-lg transition-colors"
                >
                  Delete {selectedPhotoKeys.size} selected
                </button>
              )}
              {selectedPhotoKeys.size > 0 && (
                <button
                  onClick={() => setSelectedPhotoKeys(new Set())}
                  className="text-xs text-[#555] hover:text-white px-2 py-1.5 transition-colors"
                >
                  Cancel
                </button>
              )}
              <label className={`text-xs bg-[#1a1a1a] border border-[#2a2a2a] px-3 py-1.5 rounded-lg transition-colors ${uploadingPhotos ? 'text-[#555] cursor-not-allowed' : 'text-[#888] hover:text-white cursor-pointer'}`}>
                {uploadingPhotos ? `Uploading ${uploadPhotoProgress}` : '+ Add Photos'}
                <input type="file" accept="image/*" multiple className="hidden" onChange={handleFileInputChange} disabled={uploadingPhotos} />
              </label>
            </div>
          </div>

          {isDragOver && (
            <div className="border-2 border-dashed border-violet-500/40 rounded-xl py-10 text-center text-sm text-violet-400 pointer-events-none">
              Drop photos here
            </div>
          )}

          {!isDragOver && !loadingPhotos && sourcePhotos.length === 0 && (
            <div className="border-2 border-dashed border-[#2a2a2a] rounded-xl py-8 text-center text-xs text-[#444]">
              Drag photos here or click + Add Photos
            </div>
          )}

          {!isDragOver && sourcePhotos.length > 0 && (
            <div className="grid grid-cols-5 gap-2">
              {sourcePhotos.map(photo => {
                const selected = selectedPhotoKeys.has(photo.key)
                return (
                  <div
                    key={photo.key}
                    className="relative group aspect-square cursor-pointer"
                    onClick={() => toggleSelectPhoto(photo.key)}
                  >
                    <img
                      src={photo.signedUrl}
                      alt={photo.filename}
                      className={`w-full h-full object-cover rounded-lg border-2 transition-colors ${selected ? 'border-violet-500' : 'border-transparent'}`}
                    />
                    {/* Selection checkmark */}
                    <div className={`absolute top-1 right-1 w-5 h-5 rounded-full border-2 flex items-center justify-center text-[10px] font-bold transition-all ${selected ? 'bg-violet-500 border-violet-500 text-white opacity-100' : 'bg-black/40 border-white/30 text-transparent group-hover:opacity-100 opacity-0'}`}>
                      ✓
                    </div>
                    {/* Single delete on hover (only when nothing selected) */}
                    {selectedPhotoKeys.size === 0 && (
                      <button
                        onClick={e => { e.stopPropagation(); handleDeleteSourcePhoto(photo.key) }}
                        className="absolute bottom-1 right-1 w-6 h-6 bg-black/70 rounded-md opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-red-400 text-xs font-bold"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          <p className="text-[10px] text-[#444]">After adding or removing photos, hit Regenerate on the character sheet below to rebuild it.</p>
        </div>

        {/* Character sheet */}
        <div className="bg-[#111] border border-[#1a1a1a] rounded-xl p-6 space-y-4">
          <h3 className="text-sm font-medium">Character Sheet</h3>

          {(model.sheet_status === 'queued' || model.sheet_status === 'starting' || model.sheet_status === 'polling' || model.sheet_status === 'generating') ? (
            <div className="flex items-start gap-3 py-1">
              <div className="w-5 h-5 border-2 border-violet-400/30 border-t-violet-400 rounded-full animate-spin shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-[#ccc]">
                  {model.sheet_status === 'queued' ? 'Queued...' :
                   model.sheet_status === 'starting' ? 'Uploading photos...' :
                   model.sheet_status === 'polling' ? 'Generating...' : 'Generating...'}
                </p>
                <p className="text-xs text-[#555] mt-0.5">
                  {model.sheet_status === 'queued'
                    ? 'Will be picked up automatically within 5 minutes.'
                    : model.sheet_status === 'starting'
                    ? 'Compressing and uploading source photos to kie.ai...'
                    : 'Takes ~8 minutes. This page refreshes automatically every 10 seconds.'}
                </p>
              </div>
            </div>
          ) : model.sheet_status === 'error' ? (
            <div className="space-y-3">
              <p className="text-xs text-red-400">Generation failed. Check the pipeline worker logs for details.</p>
              <button
                onClick={handleGenerateSheet}
                disabled={sheetQueuing}
                className="text-xs bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg transition-colors"
              >
                {sheetQueuing ? 'Queuing...' : 'Try Again'}
              </button>
            </div>
          ) : model.character_sheet_r2_key ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs text-[#ccc]">Character sheet ready</p>
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
                  <button
                    onClick={handleGenerateSheet}
                    disabled={sheetQueuing}
                    className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-red-400 hover:text-red-300 hover:border-red-400/30 px-3 py-1.5 rounded-lg disabled:opacity-50 transition-colors"
                  >
                    {sheetQueuing ? 'Queuing...' : 'Regenerate'}
                  </button>
                </div>
              </div>
              {model.character_sheet_signed_url && (
                <div className="space-y-2">
                  <img
                    src={model.character_sheet_signed_url}
                    alt="Character sheet"
                    className="w-full rounded-lg border border-[#2a2a2a]"
                    style={{ imageRendering: 'auto' }}
                  />
                  <p className="text-[10px] text-[#444]">This is what AI uses as a face reference for every generation. If it looks wrong, hit Regenerate.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-[#888]">No character sheet yet. Generate one from the source photos above — the pipeline worker will process it automatically.</p>
              <button
                onClick={handleGenerateSheet}
                disabled={sheetQueuing || loadingPhotos || sourcePhotos.length === 0}
                className="text-sm bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-5 py-2 rounded-lg transition-colors font-medium"
              >
                {sheetQueuing ? 'Queuing...' : 'Generate Sheet'}
              </button>
              {!loadingPhotos && sourcePhotos.length === 0 && (
                <p className="text-xs text-[#555]">Add source photos first, then come back to generate the sheet.</p>
              )}
            </div>
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
