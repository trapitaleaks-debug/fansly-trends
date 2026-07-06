'use client'
// Templates v2 — three species, three tabs:
//   Captions: what the text SAYS (harvested trending copy + user customs)
//   Memes:    structural LAYOUTS (green-screen/meme templates; replace the whole look)
//   Styles:   visual TREATMENTS (glow/hearts/filters; dress caption videos, never memes)
import { useState, useEffect } from 'react'
import Link from 'next/link'
import GenerateModal from './GenerateModal'
import VideoTemplates from './VideoTemplates'
import CaptionTemplates from './CaptionTemplates'

type Tab = 'captions' | 'memes' | 'styles'

export default function TemplatesPage() {
  const [tab, setTab] = useState<Tab>('captions')
  const [contentTags, setContentTags] = useState<string[]>([])
  const [generating, setGenerating] = useState<{ id: string; text_template: string } | null>(null)
  const [memeShare, setMemeShare] = useState<number | null>(null)

  useEffect(() => {
    fetch('/api/settings/content-tags')
      .then(r => r.json())
      .then(d => setContentTags(d.tags ?? []))
      .catch(() => {})
    fetch('/api/settings/meme-share')
      .then(r => r.json())
      .then(d => setMemeShare(d.meme_share ?? 25))
      .catch(() => {})
  }, [])

  async function saveMemeShare(v: number) {
    setMemeShare(v)
    await fetch('/api/settings/meme-share', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meme_share: v }),
    }).catch(() => {})
  }

  const TAB_HINT: Record<Tab, string> = {
    captions: 'The text on screen — trending copy + your own. Click a row to see the original video.',
    memes: 'Full layouts (green screen / memes). A video is EITHER a meme OR a styled caption — never both.',
    styles: 'Visual treatments applied on top of caption videos (never on memes). Target by niche + tags.',
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <nav className="bg-[#0f0f0f] border-b border-[#1e1e1e] px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <h1 className="text-sm font-bold text-white">FanslyTrends</h1>
        <div className="flex gap-4 text-xs text-[#666]">
          <Link href="/" className="hover:text-white transition-colors">Feed</Link>
          <Link href="/ideas" className="hover:text-white transition-colors">Ideas</Link>
          <Link href="/models" className="hover:text-white transition-colors">Models</Link>
          <span className="text-white">Templates</span>
          <Link href="/generated" className="hover:text-white transition-colors">Generated</Link>
          <Link href="/settings" className="hover:text-white transition-colors">Settings</Link>
        </div>
      </nav>

      <div className="px-6 py-5 border-b border-[#1a1a1a] flex flex-wrap items-center gap-4">
        <div className="flex gap-1 bg-[#111] border border-[#1e1e1e] rounded-xl p-1">
          {([['captions', '✍️ Captions'], ['memes', '🟩 Memes'], ['styles', '✨ Styles']] as const).map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)}
              className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${tab === key ? 'bg-white text-black font-medium' : 'text-[#666] hover:text-[#999]'}`}>
              {label}
            </button>
          ))}
        </div>
        <p className="text-xs text-[#555] flex-1 min-w-[200px]">{TAB_HINT[tab]}</p>
        {tab === 'memes' && memeShare != null && (
          <label className="flex items-center gap-2 text-xs text-[#999]">
            Meme share
            <input type="range" min={0} max={100} step={5} value={memeShare}
              onChange={e => saveMemeShare(Number(e.target.value))} className="accent-violet-500 w-32" />
            <span className="tabular-nums w-9 text-violet-300">{memeShare}%</span>
          </label>
        )}
        <Link href="/templates/jobs" className="text-xs text-[#555] hover:text-white transition-colors border border-[#222] px-3 py-1.5 rounded-lg">
          View jobs →
        </Link>
      </div>

      {tab === 'captions' && <CaptionTemplates contentTags={contentTags} onGenerate={setGenerating} />}
      {tab === 'memes' && <VideoTemplates contentTags={contentTags} kinds={['meme', 'overlay']} />}
      {tab === 'styles' && <VideoTemplates contentTags={contentTags} kinds={['caption']} />}

      {generating && <GenerateModal template={generating} onClose={() => setGenerating(null)} />}
    </div>
  )
}
