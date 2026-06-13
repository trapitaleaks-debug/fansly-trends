'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'

type JobStatus = 'pending' | 'approved' | 'rendering' | 'done' | 'failed'

interface Job {
  id: string
  original_template: string
  personalized_text: string | null
  status: JobStatus
  created_at: string
  trends_models: { fansly_username: string } | null
  model_clips: { filename: string | null; r2_key: string } | null
  trends_posts: { creator_username: string; caption: string | null } | null
}

const STATUS_COLORS: Record<JobStatus, string> = {
  pending: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/20',
  approved: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  rendering: 'text-purple-400 bg-purple-400/10 border-purple-400/20',
  done: 'text-green-400 bg-green-400/10 border-green-400/20',
  failed: 'text-red-500 bg-red-500/10 border-red-500/20',
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<JobStatus | 'all'>('all')

  const fetchJobs = useCallback(async () => {
    const url = filter === 'all' ? '/api/video-jobs' : `/api/video-jobs?status=${filter}`
    const res = await fetch(url)
    const { jobs } = await res.json()
    setJobs(jobs ?? [])
    setLoading(false)
  }, [filter])

  useEffect(() => {
    setLoading(true)
    fetchJobs()
  }, [fetchJobs])

  async function updateStatus(jobId: string, status: JobStatus) {
    await fetch(`/api/video-jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    fetchJobs()
  }

  async function deleteJob(jobId: string) {
    await fetch(`/api/video-jobs/${jobId}`, { method: 'DELETE' })
    fetchJobs()
  }

  const FILTERS: { label: string; value: JobStatus | 'all' }[] = [
    { label: 'All', value: 'all' },
    { label: 'Pending', value: 'pending' },
    { label: 'Approved', value: 'approved' },
    { label: 'Rendering', value: 'rendering' },
    { label: 'Done', value: 'done' },
    { label: 'Failed', value: 'failed' },
  ]

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <nav className="bg-[#0f0f0f] border-b border-[#1e1e1e] px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <h1 className="text-sm font-bold text-white">FanslyTrends</h1>
        <div className="flex gap-4 text-xs text-[#666]">
          <Link href="/" className="hover:text-white transition-colors">Feed</Link>
          <Link href="/ideas" className="hover:text-white transition-colors">Ideas</Link>
          <Link href="/models" className="hover:text-white transition-colors">Models</Link>
          <Link href="/pipeline" className="hover:text-white transition-colors">Pipeline</Link>
          <Link href="/templates" className="hover:text-white transition-colors">Templates</Link>
        </div>
      </nav>

      <div className="px-6 py-5 border-b border-[#1a1a1a] flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">Video Jobs</h2>
          <p className="text-xs text-[#555] mt-0.5">Queued renders — approve to send to renderer</p>
        </div>
        <Link href="/templates" className="text-xs text-[#555] hover:text-white transition-colors border border-[#222] px-3 py-1.5 rounded-lg">
          ← Templates
        </Link>
      </div>

      {/* Filters */}
      <div className="px-6 py-3 flex gap-2 border-b border-[#1a1a1a]">
        {FILTERS.map(f => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`text-xs px-3 py-1 rounded-full border transition-colors ${
              filter === f.value
                ? 'bg-[#D41020] border-[#D41020] text-white'
                : 'border-[#1e1e1e] text-[#555] hover:border-[#2a2a2a] hover:text-[#888]'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex justify-center py-16">
          <div className="w-5 h-5 border-2 border-[#333] border-t-white rounded-full animate-spin" />
        </div>
      )}

      {!loading && jobs.length === 0 && (
        <div className="text-center py-20 text-[#444]">
          <p>No jobs found</p>
          <Link href="/templates" className="mt-3 inline-block text-xs text-[#555] hover:text-white underline underline-offset-2">
            Create one from Templates →
          </Link>
        </div>
      )}

      <div className="p-6 flex flex-col gap-3">
        {jobs.map(job => (
          <JobRow
            key={job.id}
            job={job}
            onStatusChange={status => updateStatus(job.id, status)}
            onDelete={() => deleteJob(job.id)}
          />
        ))}
      </div>
    </div>
  )
}

function JobRow({ job, onStatusChange, onDelete }: { job: Job; onStatusChange: (s: JobStatus) => void; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const lines = (job.personalized_text ?? job.original_template).split('\n').filter(Boolean)
  const clip = job.model_clips

  return (
    <div className="bg-[#111] border border-[#1e1e1e] rounded-xl overflow-hidden">
      <div
        className="px-4 py-3 flex items-center gap-4 cursor-pointer hover:bg-[#141414] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Status */}
        <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${STATUS_COLORS[job.status]}`}>
          {job.status}
        </span>

        {/* Model */}
        <span className="text-sm text-white font-medium min-w-0 truncate">
          @{job.trends_models?.fansly_username ?? '—'}
        </span>

        {/* Text preview */}
        <span className="text-xs text-[#555] font-mono truncate flex-1 min-w-0">
          {lines[0]}
        </span>

        {/* Clip */}
        <span className="text-xs text-[#444] flex-shrink-0">
          {clip ? clip.filename ?? clip.r2_key.split('/').pop() : 'auto-pick'}
        </span>

        <span className="text-[#444] text-xs flex-shrink-0">{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div className="px-4 pb-4 border-t border-[#1a1a1a] pt-3 flex flex-col gap-3">
          {/* Full text */}
          <div className="bg-[#0a0a0a] rounded-lg px-3 py-3">
            {lines.map((line, i) => (
              <p key={i} className="text-sm text-white font-mono leading-snug">{line}</p>
            ))}
            {job.personalized_text && job.personalized_text !== job.original_template && (
              <p className="text-[10px] text-[#444] mt-2 font-sans">Original: {job.original_template.split('\n')[0]}...</p>
            )}
          </div>

          {/* Source */}
          <p className="text-xs text-[#444]">
            Source: @{job.trends_posts?.creator_username ?? '—'}
            {job.trends_posts?.caption ? ` · ${job.trends_posts.caption.slice(0, 60)}` : ''}
          </p>

          {/* Actions */}
          <div className="flex gap-2 flex-wrap">
            {job.status === 'pending' && (
              <button
                onClick={() => onStatusChange('approved')}
                className="text-xs bg-green-500/10 border border-green-500/20 text-green-400 hover:bg-green-500/20 px-3 py-1.5 rounded-lg transition-colors"
              >
                Approve
              </button>
            )}
            {job.status === 'approved' && (
              <button
                onClick={() => onStatusChange('rendering')}
                className="text-xs bg-purple-500/10 border border-purple-500/20 text-purple-400 hover:bg-purple-500/20 px-3 py-1.5 rounded-lg transition-colors"
              >
                Start render
              </button>
            )}
            {job.status === 'rendering' && (
              <button
                onClick={() => onStatusChange('done')}
                className="text-xs bg-green-500/10 border border-green-500/20 text-green-400 hover:bg-green-500/20 px-3 py-1.5 rounded-lg transition-colors"
              >
                Mark done
              </button>
            )}
            {job.status !== 'done' && (
              <button
                onClick={() => onStatusChange('failed')}
                className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-[#555] hover:text-[#888] px-3 py-1.5 rounded-lg transition-colors"
              >
                Mark failed
              </button>
            )}
            <button
              onClick={onDelete}
              className="text-xs text-[#444] hover:text-red-500 ml-auto transition-colors"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
