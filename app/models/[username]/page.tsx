'use client'
import { useState, useEffect, useCallback, use } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type Post } from '@/components/PostCard'
import PostModal from '@/components/PostModal'
import { useNiches } from '@/components/NichesProvider'
import ContentBank from '@/components/ContentBank'

// loaded from /api/settings/content-tags

interface Model {
  id: string
  fansly_username: string
  fansly_url: string | null
  niches: string[]
  placeholder_options: string[]
  brand_html_r2_key: string | null
  video_brand_config: Record<string, unknown> | null
  updated_at: string
}

interface VideoJob {
  id: string
  status: string
  model_id: string
  output_r2_key: string | null
  thumbnail_r2_key: string | null
  personalized_text: string | null
  clip_id: string | null
  model_clips: { id: string; filename: string | null } | null
}

interface MatchedIdea {
  id: string
  niches: string[]
  tags: string[]
  notes: string
  trends_posts: Post & {
    video_jobs?: VideoJob[]
  }
}

type GeneratedFilter = 'not_generated' | 'generated' | 'all'

export default function ModelDetailPage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = use(params)
  const router = useRouter()

  const [model, setModel] = useState<Model | null>(null)
  const [loading, setLoading] = useState(true)

  const [niches, setNiches] = useState<string[]>([])
  const [savingNiches, setSavingNiches] = useState(false)

  // Placeholder options
  const [placeholderOptions, setPlaceholderOptions] = useState<string[]>([])
  const [newOption, setNewOption] = useState('')
  const [savingPlaceholders, setSavingPlaceholders] = useState(false)

  // Brand config
  const [brandConfig, setBrandConfig] = useState<Record<string, unknown> | null>(null)
  const [uploadingBrand, setUploadingBrand] = useState(false)

  const [matchedIdeas, setMatchedIdeas] = useState<MatchedIdea[]>([])
  const [ideasLoading, setIdeasLoading] = useState(false)
  const [generatedFilter, setGeneratedFilter] = useState<GeneratedFilter>('not_generated')
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null)

  const [generatingIds, setGeneratingIds] = useState<Record<string, 'pending' | 'error'>>({})
  const [generatingAll, setGeneratingAll] = useState(false)
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null)

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [contentTags, setContentTags] = useState<string[]>([])
  const [watchJob, setWatchJob] = useState<{ id: string; url: string | null; text: string | null; loading: boolean } | null>(null)
  const { niches: allNiches, badgeClass, nicheEmoji } = useNiches()

  useEffect(() => { fetchModel() }, [username])
  useEffect(() => {
    fetch('/api/settings/content-tags').then(r => r.json()).then(d => setContentTags(d.tags ?? []))
  }, [])

  async function fetchModel(silent = false) {
    if (!silent) setLoading(true)
    const res = await fetch(`/api/models/${username}`)
    if (!res.ok) { router.push('/models'); return }
    const data = await res.json()
    setModel(data.model)
    if (!silent) {
      setNiches(data.model.niches ?? [])
      setPlaceholderOptions(data.model.placeholder_options ?? [])
      setBrandConfig(data.model.video_brand_config ?? null)
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

  useEffect(() => { if (!loading) fetchMatchedIdeas() }, [loading, fetchMatchedIdeas])

  // Auto-poll when any job for this model is pending/processing
  useEffect(() => {
    if (!model) return
    const hasActive = matchedIdeas.some(idea =>
      (idea.trends_posts.video_jobs ?? []).some(j =>
        j.model_id === model.id && (j.status === 'pending' || j.status === 'processing')
      )
    )
    if (!hasActive) return
    const t = setInterval(() => fetchMatchedIdeas(), 5000)
    return () => clearInterval(t)
  }, [matchedIdeas, model, fetchMatchedIdeas])

  async function toggleNiche(niche: string) {
    const next = niches.includes(niche) ? niches.filter(n => n !== niche) : [...niches, niche]
    setNiches(next)
    setSavingNiches(true)
    await fetch(`/api/models/${username}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ niches: next }) })
    setSavingNiches(false)
    fetchMatchedIdeas()
  }

  async function savePlaceholders(next: string[]) {
    setSavingPlaceholders(true)
    await fetch(`/api/models/${username}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ placeholder_options: next }) })
    setSavingPlaceholders(false)
  }

  function addPlaceholder() {
    const val = newOption.trim()
    if (!val || placeholderOptions.includes(val)) return
    const next = [...placeholderOptions, val]
    setPlaceholderOptions(next)
    setNewOption('')
    savePlaceholders(next)
  }

  function removePlaceholder(opt: string) {
    const next = placeholderOptions.filter(o => o !== opt)
    setPlaceholderOptions(next)
    savePlaceholders(next)
  }

  async function toggleIdeaTag(ideaId: string, tag: string, currentTags: string[]) {
    let next: string[]
    if (currentTags.includes(tag)) {
      next = currentTags.filter(t => t !== tag)
    } else if (tag === 'all') {
      next = ['all'] // selecting "all" clears specific tags
    } else {
      next = [...currentTags.filter(t => t !== 'all'), tag] // selecting specific tag clears "all"
    }
    setMatchedIdeas(prev => prev.map(i => i.id === ideaId ? { ...i, tags: next } : i))
    await fetch(`/api/ideas/${ideaId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: next }) })
  }

  async function handleDelete() {
    await fetch(`/api/models/${username}`, { method: 'DELETE' })
    router.push('/models')
  }

  async function openWatch(job: VideoJob) {
    setWatchJob({ id: job.id, url: null, text: job.personalized_text, loading: true })
    const res = await fetch(`/api/video-jobs/${job.id}`)
    if (res.ok) {
      const data = await res.json()
      setWatchJob({ id: job.id, url: data.video_url, text: data.personalized_text, loading: false })
    } else {
      setWatchJob(prev => prev ? { ...prev, loading: false } : null)
    }
  }

  async function generateIdea(postId: string) {
    setGeneratingIds(prev => ({ ...prev, [postId]: 'pending' }))
    const res = await fetch(`/api/models/${username}/generate-idea`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post_id: postId }),
    })
    if (res.ok) {
      setGeneratingIds(prev => { const n = { ...prev }; delete n[postId]; return n })
      fetchMatchedIdeas()
    } else {
      setGeneratingIds(prev => ({ ...prev, [postId]: 'error' }))
    }
  }

  async function deleteJob(jobId: string) {
    setDeletingJobId(jobId)
    await fetch(`/api/video-jobs/${jobId}`, { method: 'DELETE' })
    setDeletingJobId(null)
    setMatchedIdeas(prev => prev.map(idea => ({
      ...idea,
      trends_posts: {
        ...idea.trends_posts,
        video_jobs: (idea.trends_posts.video_jobs ?? []).filter(j => j.id !== jobId),
      },
    })))
  }

  async function generateAll() {
    const targets = filteredIdeas.filter(idea => !generatingIds[idea.trends_posts.id])
    if (!targets.length) return
    setGeneratingAll(true)
    await Promise.all(targets.map(idea => generateIdea(idea.trends_posts.id)))
    setGeneratingAll(false)
  }

  async function handleBrandHtmlUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingBrand(true)
    const form = new FormData()
    form.append('file', file)
    const res = await fetch(`/api/models/${username}/brand-html`, { method: 'POST', body: form })
    if (res.ok) {
      const data = await res.json()
      setBrandConfig(data.config ?? null)
    }
    setUploadingBrand(false)
    e.target.value = ''
  }

  async function removeBrandHtml() {
    await fetch(`/api/models/${username}/brand-html`, { method: 'DELETE' })
    setBrandConfig(null)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-[#333] border-t-white rounded-full animate-spin" />
      </div>
    )
  }

  if (!model) return null

  const modelId = model.id

  const notGeneratedIdeas = matchedIdeas.filter(idea => {
    const jobs = (idea.trends_posts.video_jobs ?? []).filter(j => j.model_id === modelId)
    return jobs.length === 0
  })

  const generatedIdeas = matchedIdeas.filter(idea => {
    const jobs = (idea.trends_posts.video_jobs ?? []).filter(j => j.model_id === modelId)
    return jobs.length > 0
  })

  const filteredIdeas = generatedFilter === 'not_generated' ? notGeneratedIdeas
    : generatedFilter === 'generated' ? generatedIdeas
    : matchedIdeas

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <nav className="bg-[#0f0f0f] border-b border-[#1e1e1e] px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <h1 className="text-sm font-bold text-white">FanslyTrends</h1>
        <div className="flex gap-4 text-xs text-[#666]">
          <Link href="/" className="hover:text-white transition-colors">Feed</Link>
          <Link href="/ideas" className="hover:text-white transition-colors">Ideas</Link>
          <Link href="/models" className="text-white">Models</Link>
          <Link href="/generated" className="hover:text-white transition-colors">Generated</Link>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">@{model.fansly_username}</h2>
            <a href={model.fansly_url ?? `https://fansly.com/${model.fansly_username}`} target="_blank" rel="noopener noreferrer"
              className="text-xs text-[#555] hover:text-[#888] transition-colors mt-0.5 block">
              fansly.com/{model.fansly_username} ↗
            </a>
          </div>
          <div className="flex gap-2">
            {!confirmDelete ? (
              <button onClick={() => setConfirmDelete(true)} className="text-xs text-[#444] hover:text-red-400 border border-[#1e1e1e] hover:border-red-400/30 px-3 py-1.5 rounded-lg transition-colors">Delete</button>
            ) : (
              <div className="flex gap-2 items-center">
                <span className="text-xs text-[#666]">Are you sure?</span>
                <button onClick={handleDelete} className="text-xs text-red-400 hover:text-red-300 px-3 py-1.5 rounded-lg border border-red-400/30 transition-colors">Yes, delete</button>
                <button onClick={() => setConfirmDelete(false)} className="text-xs text-[#666] hover:text-white px-3 py-1.5 rounded-lg transition-colors">Cancel</button>
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
              <button key={n.name} onClick={() => toggleNiche(n.name)} disabled={savingNiches}
                className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors disabled:opacity-60 ${niches.includes(n.name) ? badgeClass(n.name) : 'border-[#2a2a2a] text-[#444] hover:border-[#3a3a3a] hover:text-[#666]'}`}>
                {n.emoji} {n.name}
              </button>
            ))}
          </div>
        </div>

        {/* Placeholder */}
        <div className="bg-[#111] border border-[#1e1e1e] rounded-xl p-5 space-y-3">
          <div>
            <h3 className="text-sm font-medium">Placeholder options</h3>
            <p className="text-xs text-[#444] mt-0.5">Short descriptor inserted where <span className="font-mono text-[#666]">[placeholder]</span> appears in templates. Add multiple options.</p>
          </div>

          {/* Existing options */}
          {placeholderOptions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {placeholderOptions.map(opt => (
                <div key={opt} className="flex items-center gap-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded-full pl-3 pr-1 py-1">
                  <span className="text-xs text-white">{opt}</span>
                  <button onClick={() => removePlaceholder(opt)} className="text-[#555] hover:text-red-400 transition-colors text-sm leading-none w-5 h-5 flex items-center justify-center">×</button>
                </div>
              ))}
            </div>
          )}

          {/* Add new option */}
          <div className="flex gap-2">
            <input
              value={newOption}
              onChange={e => setNewOption(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPlaceholder() } }}
              placeholder='e.g. "18yo blonde"'
              className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-xs text-white placeholder-[#444] focus:outline-none focus:border-[#444]"
            />
            <button onClick={addPlaceholder} disabled={!newOption.trim() || savingPlaceholders}
              className="text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:text-white px-3 py-2 rounded-lg disabled:opacity-40 transition-colors">
              Add
            </button>
          </div>
          {placeholderOptions.length === 0 && <p className="text-xs text-[#444]">No options yet. Add at least one so templates can be personalized.</p>}
        </div>

        {/* Brand Style */}
        <div className="bg-[#111] border border-[#1e1e1e] rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium">Video Brand Style</h3>
              <p className="text-xs text-[#444] mt-0.5">Upload the model&apos;s Video Brand <span className="font-mono text-[#555]">.md</span> profile to define font, color, effects, and stickers</p>
            </div>
            {brandConfig && (
              <span className="text-[10px] font-medium text-green-400 border border-green-500/30 px-2 py-0.5 rounded-full">Active</span>
            )}
          </div>

          {brandConfig && (
            <div className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-lg px-3 py-2.5 space-y-1">
              <p className="text-[11px] text-[#888]">
                <span className="text-[#555]">Font: </span>{String(brandConfig.font_primary ?? '—')} {String(brandConfig.font_weight ?? '')} {String(brandConfig.font_style ?? '')}
              </p>
              <p className="text-[11px] text-[#888]">
                <span className="text-[#555]">Color: </span>
                <span style={{ color: String(brandConfig.color_text ?? '#fff') }}>{String(brandConfig.color_text ?? '—')}</span>
              </p>
              {(brandConfig.stickers as string[] | undefined)?.length ? (
                <p className="text-[11px] text-[#888]">
                  <span className="text-[#555]">Stickers: </span>{(brandConfig.stickers as string[]).join(' ')}
                </p>
              ) : null}
            </div>
          )}

          <div className="flex gap-2 items-center">
            <label className={`inline-block text-xs px-3 py-1.5 rounded-lg border transition-colors ${uploadingBrand ? 'opacity-50 border-[#2a2a2a] text-[#444]' : 'border-[#2a2a2a] text-[#888] hover:text-white hover:border-[#444] cursor-pointer'}`}>
              {uploadingBrand ? 'Uploading...' : brandConfig ? 'Replace profile' : 'Upload brand profile (.md)'}
              <input type="file" accept=".md,.json" className="hidden" onChange={handleBrandHtmlUpload} disabled={uploadingBrand} />
            </label>
            {brandConfig && (
              <button onClick={removeBrandHtml}
                className="text-xs text-[#444] hover:text-red-400 border border-[#2a2a2a] hover:border-red-400/30 px-3 py-1.5 rounded-lg transition-colors">
                Remove
              </button>
            )}
          </div>

          {!brandConfig && (
            <p className="text-xs text-[#444]">No brand profile. Videos use default white Arial Black style.</p>
          )}
        </div>

        {/* Content Bank */}
        <div className="bg-[#111] border border-[#1e1e1e] rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-medium">Content Bank</h3>
          <ContentBank username={username} />
        </div>

        {/* Matched Ideas */}
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h3 className="text-sm font-medium">Matched Ideas</h3>
              <p className="text-xs text-[#444] mt-0.5">Bookmarked posts that share this model&apos;s niches</p>
            </div>
            {niches.length === 0 && <span className="text-xs text-[#444]">Assign niches above to see matches</span>}
          </div>

          {matchedIdeas.length > 0 && (
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex gap-1 bg-[#111] border border-[#1e1e1e] rounded-xl p-1 w-fit">
                {(['not_generated', 'generated', 'all'] as const).map(f => (
                  <button key={f} onClick={() => setGeneratedFilter(f)}
                    className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${generatedFilter === f ? 'bg-white text-black font-medium' : 'text-[#666] hover:text-[#999]'}`}>
                    {f === 'all' ? `All (${matchedIdeas.length})` : f === 'not_generated' ? `Not generated (${notGeneratedIdeas.length})` : `Generated (${generatedIdeas.length})`}
                  </button>
                ))}
              </div>
              {generatedFilter !== 'all' && filteredIdeas.length > 0 && (
                <button onClick={generateAll} disabled={generatingAll}
                  className="text-xs bg-[#D41020] hover:bg-[#b50d1a] disabled:opacity-50 text-white px-3 py-1.5 rounded-lg transition-colors">
                  {generatingAll ? 'Generating...' : generatedFilter === 'not_generated' ? `Generate all (${notGeneratedIdeas.length})` : `Regenerate all (${generatedIdeas.length})`}
                </button>
              )}
            </div>
          )}

          {ideasLoading ? (
            <div className="flex justify-center py-8">
              <div className="w-5 h-5 border-2 border-[#333] border-t-white rounded-full animate-spin" />
            </div>
          ) : filteredIdeas.length === 0 ? (
            <div className="text-center py-12 text-[#444]">
              {niches.length === 0 ? <p className="text-sm">No niches assigned to this model yet</p>
                : matchedIdeas.length === 0 ? <><p className="text-sm mb-1">No matching ideas</p><p className="text-xs">Bookmark posts in the Feed and tag them with matching niches</p></>
                : <p className="text-sm">No {generatedFilter === 'generated' ? 'generated' : 'ungenerated'} ideas</p>}
            </div>
          ) : (
            <div className="border border-[#1e1e1e] rounded-xl overflow-hidden">
              {filteredIdeas.map(idea => {
                const jobs = (idea.trends_posts.video_jobs ?? []).filter(j => j.model_id === modelId)
                const useCount = jobs.length
                const post = idea.trends_posts
                const genState = generatingIds[post.id]

                return (
                  <div key={idea.id} className="border-b border-[#1a1a1a] last:border-0">
                    <div className="flex items-center gap-3 px-4 py-3 hover:bg-[#0d0d0d] transition-colors">
                      {/* Thumbnail */}
                      <button onClick={() => setSelectedPostId(post.id)} className="w-9 h-12 rounded-md overflow-hidden flex-shrink-0 bg-[#1a1a1a]">
                        {post.thumbnail_r2_key && <img src={`/api/thumb/${post.id}`} className="w-full h-full object-cover" alt="" />}
                      </button>

                      {/* Info */}
                      <button onClick={() => setSelectedPostId(post.id)} className="flex-1 min-w-0 text-left">
                        <p className="text-xs text-[#666] truncate">@{post.creator_username}</p>
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {idea.niches.map(n => <span key={n} className="text-[10px] text-[#555]">{nicheEmoji(n)} {n}</span>)}
                        </div>
                      </button>

                      {/* Usage count */}
                      {useCount > 0 && (
                        <span className="text-[10px] font-mono text-[#555] flex-shrink-0 w-5 text-center">{useCount}×</span>
                      )}

                      <span className="text-[10px] text-[#444] flex-shrink-0">
                        {post.likes_current >= 1000 ? `${(post.likes_current / 1000).toFixed(1)}K` : post.likes_current} ♥
                      </span>

                      {/* Done jobs — watch + delete per version */}
                      <div className="flex gap-1 flex-shrink-0 flex-wrap justify-end">
                        {jobs.filter(j => j.status === 'done' && j.output_r2_key).map((j, i) => (
                          <span key={j.id} className="flex items-center gap-0.5 border border-green-500/30 rounded-lg overflow-hidden">
                            <button
                              onClick={() => openWatch(j)}
                              title={j.model_clips?.filename ?? undefined}
                              className="text-[10px] font-medium px-2 py-1 text-green-400 hover:bg-green-500/10 transition-colors">
                              ▶ {i + 1}
                            </button>
                            <button
                              onClick={() => deleteJob(j.id)}
                              disabled={deletingJobId === j.id}
                              className="text-[10px] text-[#444] hover:text-red-400 disabled:opacity-40 transition-colors px-1.5 py-1 border-l border-green-500/20">
                              {deletingJobId === j.id ? '…' : '×'}
                            </button>
                          </span>
                        ))}
                        {jobs.some(j => j.status === 'pending' || j.status === 'processing') && (
                          <span className="text-[10px] text-[#555] self-center px-1">queued…</span>
                        )}
                      </div>

                      {/* Generate button */}
                      <button
                        onClick={() => generateIdea(post.id)}
                        disabled={genState === 'pending' || generatingAll || jobs.some(j => j.status === 'pending' || j.status === 'processing')}
                        className={`text-[10px] font-medium px-2 py-1 rounded-lg border flex-shrink-0 transition-colors disabled:opacity-40 ${
                          genState === 'error' ? 'border-red-500/30 text-red-400'
                          : useCount > 0 ? 'border-[#2a2a2a] text-[#555] hover:border-[#3a3a3a] hover:text-white'
                          : 'border-[#D41020]/40 text-[#D41020] hover:bg-[#D41020]/10'
                        }`}>
                        {genState === 'pending' ? '…' : genState === 'error' ? 'error' : useCount > 0 ? 'generate' : 'generate'}
                      </button>
                    </div>

                    {/* Template tags row */}
                    <div className="flex items-center gap-2 px-4 pb-2.5 pl-16">
                      <span className="text-[10px] text-[#444] flex-shrink-0">Content:</span>
                      <div className="flex flex-wrap gap-1">
                        {['all', ...contentTags].map(tag => (
                          <button key={tag} onClick={() => toggleIdeaTag(idea.id, tag, idea.tags ?? [])}
                            className={`text-[10px] px-1.5 py-0.5 rounded-full border transition-colors ${(idea.tags ?? []).includes(tag) ? 'bg-violet-500/20 border-violet-500/40 text-violet-300' : 'border-[#2a2a2a] text-[#444] hover:border-[#3a3a3a] hover:text-[#666]'}`}>
                            {tag}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

      </div>

      {selectedPostId && (
        <PostModal postId={selectedPostId} onClose={() => setSelectedPostId(null)} onBookmarkChange={fetchMatchedIdeas} />
      )}

      {watchJob && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4" onClick={() => setWatchJob(null)}>
          <div className="bg-[#111] border border-[#2a2a2a] rounded-2xl overflow-hidden max-w-sm w-full" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e1e1e]">
              <p className="text-xs text-[#888] truncate pr-4">{watchJob.text ?? 'Rendered video'}</p>
              <button onClick={() => setWatchJob(null)} className="text-[#555] hover:text-white flex-shrink-0 text-lg leading-none">×</button>
            </div>
            <div className="bg-black">
              {watchJob.loading ? (
                <div className="flex items-center justify-center h-48">
                  <div className="w-5 h-5 border-2 border-[#333] border-t-white rounded-full animate-spin" />
                </div>
              ) : watchJob.url ? (
                <video src={watchJob.url} controls autoPlay className="w-full max-h-[70vh] object-contain" />
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
