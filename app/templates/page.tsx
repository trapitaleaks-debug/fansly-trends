'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import GenerateModal from './GenerateModal'
import VideoTemplates from './VideoTemplates'
import { useNiches } from '@/components/NichesProvider'

interface Template {
  id: string
  text_template: string
  trends_ideas?: { niches: string[] }[]
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState<Template | null>(null)
  const [view, setView] = useState<'text' | 'video'>('text')
  const [contentTags, setContentTags] = useState<string[]>([])

  useEffect(() => {
    fetch('/api/templates')
      .then(r => r.json())
      .then(({ templates }) => {
        setTemplates(templates ?? [])
        setLoading(false)
      })
    fetch('/api/settings/content-tags')
      .then(r => r.json())
      .then(d => setContentTags(d.tags ?? d.content_tags ?? []))
      .catch(() => {})
  }, [])

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <nav className="bg-[#0f0f0f] border-b border-[#1e1e1e] px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <h1 className="text-sm font-bold text-white">FanslyTrends</h1>
        <div className="flex gap-4 text-xs text-[#666]">
          <Link href="/" className="hover:text-white transition-colors">Feed</Link>
          <Link href="/ideas" className="hover:text-white transition-colors">Ideas</Link>
          <Link href="/models" className="hover:text-white transition-colors">Models</Link>
          
          <span className="text-white">Templates</span>
        </div>
      </nav>

      <div className="px-6 py-5 border-b border-[#1a1a1a] flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex gap-1 bg-[#111] border border-[#1e1e1e] rounded-xl p-1">
            {([['text', 'Text Templates'], ['video', 'Video Templates']] as const).map(([key, label]) => (
              <button key={key} onClick={() => setView(key)}
                className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${view === key ? 'bg-white text-black font-medium' : 'text-[#666] hover:text-[#999]'}`}>
                {label}
              </button>
            ))}
          </div>
          <p className="text-xs text-[#555]">
            {view === 'text'
              ? (loading ? '...' : `${templates.length} saved · click Generate to personalize per model`)
              : 'CapCut-style render layouts — applied automatically by content tag'}
          </p>
        </div>
        <Link
          href="/templates/jobs"
          className="text-xs text-[#555] hover:text-white transition-colors border border-[#222] px-3 py-1.5 rounded-lg"
        >
          View jobs →
        </Link>
      </div>

      {view === 'video' && <VideoTemplates contentTags={contentTags} />}

      {view === 'text' && loading && (
        <div className="flex justify-center py-20">
          <div className="w-5 h-5 border-2 border-[#333] border-t-white rounded-full animate-spin" />
        </div>
      )}

      {view === 'text' && !loading && templates.length === 0 && (
        <div className="text-center py-24 text-[#444]">
          <p className="text-base mb-1">No templates yet</p>
          <p className="text-sm">Open a post in the Feed and type in the Text template field</p>
          <Link href="/" className="mt-4 inline-block text-xs text-[#555] hover:text-white transition-colors underline underline-offset-2">
            Go to Feed →
          </Link>
        </div>
      )}

      {view === 'text' && (
        <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {templates.map(t => (
            <TemplateCard
              key={t.id}
              template={t}
              onGenerate={() => setGenerating(t)}
            />
          ))}
        </div>
      )}

      {generating && (
        <GenerateModal
          template={generating}
          onClose={() => setGenerating(null)}
        />
      )}
    </div>
  )
}

function TemplateCard({ template: t, onGenerate }: { template: Template; onGenerate: () => void }) {
  const lines = t.text_template.split('\n').filter(Boolean)
  const niches = t.trends_ideas?.[0]?.niches ?? []
  const { badgeClass, nicheEmoji } = useNiches()

  return (
    <div className="bg-[#111] border border-[#1e1e1e] rounded-xl p-4 flex flex-col gap-3 hover:border-[#2a2a2a] transition-colors">
      {/* Template text */}
      <div className="bg-[#0a0a0a] rounded-lg px-3 py-3 min-h-[72px] flex flex-col justify-center gap-1 flex-1">
        {lines.map((line, i) => (
          <p key={i} className="text-sm text-white font-mono leading-snug">{line}</p>
        ))}
      </div>

      {/* Niches */}
      {niches.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {niches.map(n => (
            <span key={n} className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${badgeClass(n)}`}>
              {nicheEmoji(n)} {n}
            </span>
          ))}
        </div>
      )}

      <button
        onClick={onGenerate}
        className="w-full bg-[#D41020] hover:bg-[#b50d1a] text-white text-xs font-semibold py-2 rounded-lg transition-colors"
      >
        Generate →
      </button>
    </div>
  )
}
