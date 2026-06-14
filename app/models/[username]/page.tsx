'use client'
import { useState, useEffect, useCallback, use } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type Post } from '@/components/PostCard'
import PostModal from '@/components/PostModal'
import { useNiches } from '@/components/NichesProvider'

interface Model {
  id: string
  fansly_username: string
  fansly_url: string | null
  branding_file_md: string | null
  niches: string[]
  notes_for_ai: string | null
  updated_at: string
}

interface MatchedIdea {
  id: string
  niches: string[]
  notes: string
  trends_posts: Post & {
    video_jobs?: { id: string; status: string; model_id: string }[]
  }
}

type GeneratedFilter = 'all' | 'generated' | 'not_generated'

export default function ModelDetailPage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = use(params)
  const router = useRouter()

  const [model, setModel] = useState<Model | null>(null)
  const [loading, setLoading] = useState(true)

  // Branding file
  const [brandingFileName, setBrandingFileName] = useState<string | null>(null)
  const [brandingUploading, setBrandingUploading] = useState(false)

  // Niches
  const [niches, setNiches] = useState<string[]>([])
  const [savingNiches, setSavingNiches] = useState(false)

  // Matched ideas
  const [matchedIdeas, setMatchedIdeas] = useState<MatchedIdea[]>([])
  const [ideasLoading, setIdeasLoading] = useState(false)
  const [generatedFilter, setGeneratedFilter] = useState<GeneratedFilter>('all')
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null)

  // Delete
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { niches: allNiches, badgeClass, nicheEmoji } = useNiches()

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
      setNiches(data.model.niches ?? [])
      if (data.model.branding_file_md) setBrandingFileName('branding-file.md')
      setLoading(false)
    }
  }

  const fetchMatchedIdeas = useCallback(async () => {
    setIdeasLoading(true)
    const res = await fetch(`/api/models/${username}/matched-ideas`)
    if (res.ok) {
      const data = await res.json()
      setMatchedIdeas(data.ideas ?? [])
    }
    setIdeasLoading(false)
  }, [username])

  useEffect(() => {
    if (!loading) fetchMatchedIdeas()
  }, [loading, fetchMatchedIdeas])

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

  async function toggleNiche(niche: string) {
    const next = niches.includes(niche) ? niches.filter(n => n !== niche) : [...niches, niche]
    setNiches(next)
    setSavingNiches(true)
    await fetch(`/api/models/${username}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ niches: next }),
    })
    setSavingNiches(false)
    fetchMatchedIdeas()
  }

  async function handleDelete() {
    await fetch(`/api/models/${username}`, { method: 'DELETE' })
    router.push('/models')
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-[#333] border-t-white rounded-full animate-spin" />
      </div>
    )
  }

  if (!model) return null

  const modelId = model?.id
  const filteredIdeas = matchedIdeas.filter(idea => {
    const jobs = idea.trends_posts.video_jobs ?? []
    const hasGenerated = jobs.some(j => j.model_id === modelId && j.status === 'done')
    if (generatedFilter === 'generated') return hasGenerated
    if (generatedFilter === 'not_generated') return !hasGenerated
    return true
  })

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
            <h2 className="text-xl font-semibold">@{model.fansly_username}</h2>
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

        {/* Niches */}
        <div className="bg-[#111] border border-[#1e1e1e] rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium">Niches</h3>
              <p className="text-xs text-[#444] mt-0.5">Select which niches this model operates in</p>
            </div>
            {savingNiches && <span className="text-xs text-[#555]">Saving...</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            {allNiches.map(n => (
              <button
                key={n.name}
                onClick={() => toggleNiche(n.name)}
                disabled={savingNiches}
                className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors disabled:opacity-60 ${niches.includes(n.name) ? badgeClass(n.name) : 'border-[#2a2a2a] text-[#444] hover:border-[#3a3a3a] hover:text-[#666]'}`}
              >
                {n.emoji} {n.name}
              </button>
            ))}
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
            <p className="text-xs text-[#444]">No branding file yet. Upload the model&apos;s Personal Branding .md file.</p>
          )}
        </div>

        {/* Matched Ideas */}
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h3 className="text-sm font-medium">Matched Ideas</h3>
              <p className="text-xs text-[#444] mt-0.5">Bookmarked posts that share this model&apos;s niches</p>
            </div>
            {niches.length === 0 && (
              <span className="text-xs text-[#444]">Assign niches above to see matches</span>
            )}
          </div>

          {matchedIdeas.length > 0 && (
            <div className="flex gap-1 bg-[#111] border border-[#1e1e1e] rounded-xl p-1 w-fit">
              {(['all', 'not_generated', 'generated'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setGeneratedFilter(f)}
                  className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${generatedFilter === f ? 'bg-white text-black font-medium' : 'text-[#666] hover:text-[#999]'}`}
                >
                  {f === 'all' ? `All (${matchedIdeas.length})` : f === 'not_generated' ? 'Not generated' : 'Generated'}
                </button>
              ))}
            </div>
          )}

          {ideasLoading ? (
            <div className="flex justify-center py-8">
              <div className="w-5 h-5 border-2 border-[#333] border-t-white rounded-full animate-spin" />
            </div>
          ) : filteredIdeas.length === 0 ? (
            <div className="text-center py-12 text-[#444]">
              {niches.length === 0 ? (
                <p className="text-sm">No niches assigned to this model yet</p>
              ) : matchedIdeas.length === 0 ? (
                <>
                  <p className="text-sm mb-1">No matching ideas</p>
                  <p className="text-xs">Bookmark posts in the Feed and tag them with matching niches</p>
                </>
              ) : (
                <p className="text-sm">No {generatedFilter === 'generated' ? 'generated' : 'ungenerated'} ideas</p>
              )}
            </div>
          ) : (
            <div className="border border-[#1e1e1e] rounded-xl overflow-hidden">
              {filteredIdeas.map(idea => {
                const jobs = idea.trends_posts.video_jobs ?? []
                const modelJobs = jobs.filter(j => j.model_id === modelId)
                const doneCount = modelJobs.filter(j => j.status === 'done').length
                const hasAny = modelJobs.length > 0
                const post = idea.trends_posts

                return (
                  <button
                    key={idea.id}
                    onClick={() => setSelectedPostId(post.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 border-b border-[#1a1a1a] last:border-0 hover:bg-[#111] transition-colors text-left"
                  >
                    {/* Thumbnail */}
                    <div className="w-9 h-12 rounded-md overflow-hidden flex-shrink-0 bg-[#1a1a1a]">
                      {post.thumbnail_r2_key && (
                        <img src={`/api/thumb/${post.id}`} className="w-full h-full object-cover" alt="" />
                      )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-[#666] truncate">@{post.creator_username}</p>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {idea.niches.map(n => (
                          <span key={n} className="text-[10px] text-[#555]">{nicheEmoji(n)} {n}</span>
                        ))}
                      </div>
                    </div>

                    {/* Status + likes */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${doneCount > 0 ? 'bg-green-500/20 text-green-400 border-green-500/30' : hasAny ? 'bg-blue-500/20 text-blue-400 border-blue-500/30' : 'bg-[#1a1a1a] text-[#555] border-[#2a2a2a]'}`}>
                        {doneCount > 0 ? `✓ ${doneCount}x` : hasAny ? 'queued' : 'not generated'}
                      </span>
                      <span className="text-[10px] text-[#444]">
                        {post.likes_current >= 1000 ? `${(post.likes_current / 1000).toFixed(1)}K` : post.likes_current} ♥
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

      </div>

      {selectedPostId && (
        <PostModal
          postId={selectedPostId}
          onClose={() => setSelectedPostId(null)}
          onBookmarkChange={fetchMatchedIdeas}
        />
      )}
    </div>
  )
}
