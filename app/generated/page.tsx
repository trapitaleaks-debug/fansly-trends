'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'

type JobStatus = 'pending' | 'processing' | 'done' | 'error'

interface Job {
  id: string
  status: JobStatus
  personalized_text: string | null
  output_r2_key: string | null
  thumbnail_r2_key: string | null
  error_message: string | null
  post_fail_count: number | null
  failure_kind: string | null
  needs_review: boolean | null
  diagnosis: string | null
  created_at: string
  updated_at: string
  trends_models: { fansly_username: string } | null
  trends_posts: { creator_username: string; thumbnail_r2_key: string | null } | null
}

interface WatchState {
  jobId: string
  url: string | null
  text: string | null
  loading: boolean
}

const STATUS_LABEL: Record<JobStatus, string> = {
  pending: 'Queued',
  processing: 'Rendering',
  done: 'Done',
  error: 'Error',
}

const STATUS_DOT: Record<JobStatus, string> = {
  pending: 'bg-[#444]',
  processing: 'bg-yellow-400 animate-pulse',
  done: 'bg-green-400',
  error: 'bg-red-400',
}

type FilterTab = 'all' | 'queue' | 'done' | 'error' | 'flagged'

export default function GeneratedPage() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<FilterTab>('all')
  const [watch, setWatch] = useState<WatchState | null>(null)
  const [retrying, setRetrying] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)

  const fetchJobs = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    const res = await fetch('/api/video-jobs')
    if (res.ok) {
      const data = await res.json()
      setJobs(data.jobs ?? [])
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchJobs() }, [fetchJobs])

  // Auto-refresh every 8s if any job is pending/processing
  useEffect(() => {
    const hasActive = jobs.some(j => j.status === 'pending' || j.status === 'processing')
    if (!hasActive) return
    const t = setInterval(() => fetchJobs(true), 8000)
    return () => clearInterval(t)
  }, [jobs, fetchJobs])

  async function openWatch(job: Job) {
    setWatch({ jobId: job.id, url: null, text: job.personalized_text, loading: true })
    const res = await fetch(`/api/video-jobs/${job.id}`)
    if (res.ok) {
      const data = await res.json()
      setWatch({ jobId: job.id, url: data.video_url, text: data.personalized_text, loading: false })
    } else {
      setWatch(prev => prev ? { ...prev, loading: false } : null)
    }
  }

  async function processNow() {
    setProcessing(true)
    await fetch('/api/video-jobs/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
    await fetchJobs(true)
    setProcessing(false)
  }

  async function retryJob(job: Job) {
    setRetrying(job.id)
    await fetch(`/api/video-jobs/${job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'pending' }),
    })
    await fetchJobs(true)
    setRetrying(null)
  }

  async function retryPost(job: Job) {
    setRetrying(job.id)
    await fetch(`/api/video-jobs/${job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'retry_post' }),
    })
    await fetchJobs(true)
    setRetrying(null)
  }

  async function deleteJob(id: string) {
    setDeletingId(id)
    await fetch(`/api/video-jobs/${id}`, { method: 'DELETE' })
    setJobs(prev => prev.filter(j => j.id !== id))
    setDeletingId(null)
  }

  const queue = jobs.filter(j => j.status === 'pending' || j.status === 'processing')
  const done = jobs.filter(j => j.status === 'done')
  const errors = jobs.filter(j => j.status === 'error')
  const flagged = jobs.filter(j => j.needs_review)

  const filtered = tab === 'queue' ? queue
    : tab === 'done' ? done
    : tab === 'error' ? errors
    : tab === 'flagged' ? flagged
    : jobs

  function timeAgo(iso: string) {
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (diff < 60) return `${diff}s ago`
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    return `${Math.floor(diff / 3600)}h ago`
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <nav className="bg-[#0f0f0f] border-b border-[#1e1e1e] px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <h1 className="text-sm font-bold text-white">FanslyTrends</h1>
        <div className="flex gap-4 text-xs text-[#666]">
          <Link href="/" className="hover:text-white transition-colors">Feed</Link>
          <Link href="/ideas" className="hover:text-white transition-colors">Ideas</Link>
          <Link href="/models" className="hover:text-white transition-colors">Models</Link>
          <Link href="/generated" className="text-white">Generated</Link>
          <Link href="/settings" className="hover:text-white transition-colors">Settings</Link>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">Generated Content</h2>
            <p className="text-xs text-[#444] mt-0.5">{jobs.length} total · {queue.length} in queue · {done.length} done</p>
          </div>
          <div className="flex gap-2">
            {queue.length > 0 && (
              <button onClick={processNow} disabled={processing}
                className="text-xs bg-[#D41020] hover:bg-[#b50d1a] disabled:opacity-50 text-white px-3 py-1.5 rounded-lg transition-colors">
                {processing ? 'Starting...' : `Process queue (${queue.length})`}
              </button>
            )}
            <button onClick={() => fetchJobs()} className="text-xs text-[#555] hover:text-white border border-[#1e1e1e] px-3 py-1.5 rounded-lg transition-colors">
              Refresh
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-[#111] border border-[#1e1e1e] rounded-xl p-1 w-fit">
          {([
            ['all', `All (${jobs.length})`],
            ['queue', `Queue (${queue.length})`],
            ['done', `Done (${done.length})`],
            ['error', `Errors (${errors.length})`],
            ['flagged', `🚩 Flagged (${flagged.length})`],
          ] as const).map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)}
              className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${tab === key ? 'bg-white text-black font-medium' : 'text-[#666] hover:text-[#999]'}`}>
              {label}
            </button>
          ))}
        </div>

        {/* Job list */}
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-5 h-5 border-2 border-[#333] border-t-white rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-[#444]">
            <p className="text-sm">No {tab === 'all' ? '' : tab} jobs yet</p>
            {tab === 'all' && <p className="text-xs mt-1">Go to a model page and press Generate on a matched idea</p>}
          </div>
        ) : (
          <div className="border border-[#1e1e1e] rounded-xl overflow-hidden">
            {filtered.map(job => {
              const username = job.trends_models?.fansly_username ?? '?'
              const creator = job.trends_posts?.creator_username
              const postThumb = job.trends_posts?.thumbnail_r2_key

              return (
                <div key={job.id} className="border-b border-[#1a1a1a] last:border-0 px-4 py-3 flex items-start gap-3 hover:bg-[#0d0d0d] transition-colors">

                  {/* Post thumbnail */}
                  <div className="w-8 h-11 rounded bg-[#1a1a1a] flex-shrink-0 overflow-hidden">
                    {postThumb && <img src={`/api/thumb/${job.trends_posts ? job.id : ''}`} className="w-full h-full object-cover" alt="" />}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-white">@{username}</span>
                      {creator && <span className="text-[10px] text-[#444]">← @{creator}</span>}
                    </div>
                    <p className="text-[11px] text-[#777] leading-snug line-clamp-2">
                      {job.personalized_text ?? '—'}
                    </p>
                    {job.status === 'error' && job.error_message && (
                      <p className="text-[10px] text-red-400 leading-snug">{job.error_message}</p>
                    )}
                    {job.needs_review && (
                      <div className="mt-1 space-y-0.5">
                        <span className="inline-block text-[9px] font-semibold uppercase tracking-wide bg-red-500/15 text-red-400 border border-red-500/30 rounded px-1.5 py-0.5">
                          🚩 {job.failure_kind ?? 'needs review'}
                        </span>
                        {job.diagnosis && (
                          <p className="text-[10px] text-[#997] leading-snug whitespace-pre-line">{job.diagnosis}</p>
                        )}
                        {job.post_fail_count != null && job.post_fail_count > 0 && (
                          <p className="text-[10px] text-[#555]">{job.post_fail_count} posting attempts</p>
                        )}
                      </div>
                    )}
                    <p className="text-[10px] text-[#333]">{timeAgo(job.created_at)}</p>
                  </div>

                  {/* Status + actions */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[job.status]}`} />
                      <span className="text-[10px] text-[#555]">{STATUS_LABEL[job.status]}</span>
                    </div>

                    {job.status === 'done' && (
                      <button onClick={() => openWatch(job)}
                        className="text-[10px] font-medium px-2 py-1 rounded-lg border border-green-500/30 text-green-400 hover:bg-green-500/10 transition-colors">
                        ▶ Watch
                      </button>
                    )}

                    {job.needs_review && job.output_r2_key ? (
                      <button onClick={() => retryPost(job)} disabled={retrying === job.id}
                        className="text-[10px] font-medium px-2 py-1 rounded-lg border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 disabled:opacity-40 transition-colors">
                        {retrying === job.id ? '...' : 'Re-try post'}
                      </button>
                    ) : job.status === 'error' && (
                      <button onClick={() => retryJob(job)} disabled={retrying === job.id}
                        className="text-[10px] px-2 py-1 rounded-lg border border-[#2a2a2a] text-[#666] hover:text-white hover:border-[#3a3a3a] disabled:opacity-40 transition-colors">
                        {retrying === job.id ? '...' : 'Retry'}
                      </button>
                    )}

                    <button onClick={() => deleteJob(job.id)} disabled={deletingId === job.id}
                      className="text-[10px] text-[#333] hover:text-red-400 disabled:opacity-40 transition-colors px-1">
                      {deletingId === job.id ? '...' : '×'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Watch modal */}
      {watch && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4" onClick={() => setWatch(null)}>
          <div className="bg-[#111] border border-[#2a2a2a] rounded-2xl overflow-hidden max-w-sm w-full" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e1e1e]">
              <p className="text-xs text-[#888] truncate pr-4">{watch.text ?? 'Rendered video'}</p>
              <button onClick={() => setWatch(null)} className="text-[#555] hover:text-white flex-shrink-0 text-lg leading-none">×</button>
            </div>
            <div className="bg-black">
              {watch.loading ? (
                <div className="flex items-center justify-center h-48">
                  <div className="w-5 h-5 border-2 border-[#333] border-t-white rounded-full animate-spin" />
                </div>
              ) : watch.url ? (
                <>
                  <video src={watch.url} controls autoPlay playsInline className="w-full max-h-[70vh] object-contain" />
                  <div className="px-4 py-3 border-t border-[#1e1e1e]">
                    <a href={watch.url} download className="text-xs text-[#666] hover:text-white transition-colors">
                      ↓ Download
                    </a>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-center h-48 text-xs text-[#444]">Video not available</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
