'use client'
// Captions tab (Templates v2): compact list of all text templates (harvested + custom) with
// search, niche/tag filters, sort, bulk actions, a composer for custom templates, and a
// detail modal that shows the ORIGINAL trending video (Ideas-page style).
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNiches } from '@/components/NichesProvider'

export interface CaptionTemplate {
  id: string
  text_template: string
  is_custom: boolean
  likes_current: number
  creator_username: string
  has_video: boolean
  idea_id: string | null
  niches: string[]
  tags: string[]
  jobs: number
  posted: number
}

type Detail = CaptionTemplate & { video_url: string | null; thumb_url: string | null; hashtags: string[] }
type SortKey = 'likes' | 'used' | 'newest'

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export default function CaptionTemplates({ contentTags, onGenerate }: {
  contentTags: string[]
  onGenerate: (t: { id: string; text_template: string }) => void
}) {
  const { badgeClass, nicheEmoji, niches: nicheDefs } = useNiches()
  const allNiches = useMemo(() => nicheDefs.map(n => n.name), [nicheDefs])
  const [rows, setRows] = useState<CaptionTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [nicheFilter, setNicheFilter] = useState<string | null>(null)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [sort, setSort] = useState<SortKey>('likes')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<Detail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [composer, setComposer] = useState(false)
  const [editRow, setEditRow] = useState<CaptionTemplate | null>(null)
  const [busy, setBusy] = useState(false)

  const fetchRows = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/templates')
    if (res.ok) setRows((await res.json()).templates ?? [])
    setLoading(false)
  }, [])
  useEffect(() => { fetchRows() }, [fetchRows])

  const dupCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) {
      const k = normalize(r.text_template)
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m
  }, [rows])

  const filtered = useMemo(() => {
    let out = rows
    if (search.trim()) {
      const q = search.toLowerCase()
      out = out.filter(r => r.text_template.toLowerCase().includes(q))
    }
    if (nicheFilter) out = out.filter(r => r.niches.includes(nicheFilter))
    if (tagFilter) out = out.filter(r => r.tags.includes(tagFilter))
    if (sort === 'likes') out = [...out].sort((a, b) => b.likes_current - a.likes_current)
    if (sort === 'used') out = [...out].sort((a, b) => b.jobs - a.jobs)
    if (sort === 'newest') out = [...out].reverse()
    return out
  }, [rows, search, nicheFilter, tagFilter, sort])

  async function openDetail(row: CaptionTemplate) {
    setDetailLoading(true)
    setDetail({ ...row, video_url: null, thumb_url: null, hashtags: [] })
    const res = await fetch(`/api/templates/${row.id}/detail`)
    if (res.ok) setDetail(await res.json())
    setDetailLoading(false)
  }

  async function bulkPatch(patch: { niches?: string[]; tags?: string[] }) {
    setBusy(true)
    await Promise.all([...selected].map(id => fetch(`/api/templates/${id}/detail`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    })))
    setSelected(new Set())
    setBusy(false)
    await fetchRows()
  }

  async function bulkDelete() {
    if (!confirm(`Remove ${selected.size} template(s)? Harvested posts keep their video, customs are deleted.`)) return
    setBusy(true)
    await Promise.all([...selected].map(id => fetch(`/api/templates/${id}/detail`, { method: 'DELETE' })))
    setSelected(new Set())
    setBusy(false)
    await fetchRows()
  }

  return (
    <div className="px-6 py-5 space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search text…"
          className="bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-xs text-white placeholder-[#444] focus:outline-none focus:border-[#444] w-56" />
        <select value={nicheFilter ?? ''} onChange={e => setNicheFilter(e.target.value || null)}
          className="bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-2 py-2 text-xs text-[#999]">
          <option value="">All niches</option>
          {allNiches.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <select value={tagFilter ?? ''} onChange={e => setTagFilter(e.target.value || null)}
          className="bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-2 py-2 text-xs text-[#999]">
          <option value="">All tags</option>
          {contentTags.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={sort} onChange={e => setSort(e.target.value as SortKey)}
          className="bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-2 py-2 text-xs text-[#999]">
          <option value="likes">Most liked</option>
          <option value="used">Most used</option>
          <option value="newest">Newest</option>
        </select>
        <span className="text-xs text-[#555]">{filtered.length} / {rows.length}</span>
        <div className="flex-1" />
        <button onClick={() => setComposer(true)}
          className="bg-white text-black text-xs font-medium px-4 py-2 rounded-lg hover:bg-[#e5e5e5] transition-colors">
          + Custom template
        </button>
      </div>

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 bg-[#131320] border border-violet-500/30 rounded-xl px-4 py-2">
          <span className="text-xs text-violet-300">{selected.size} selected</span>
          <BulkAssign label="Set niches" options={allNiches} onApply={v => bulkPatch({ niches: v })} disabled={busy} />
          <BulkAssign label="Set tags" options={contentTags} onApply={v => bulkPatch({ tags: v })} disabled={busy} />
          <button onClick={bulkDelete} disabled={busy} className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40">Delete</button>
          <button onClick={() => setSelected(new Set())} className="text-xs text-[#555] hover:text-white">Clear</button>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-16"><div className="w-5 h-5 border-2 border-[#333] border-t-white rounded-full animate-spin" /></div>
      ) : (
        <div className="border border-[#1e1e1e] rounded-xl overflow-hidden">
          {filtered.map(r => {
            const isDup = (dupCounts.get(normalize(r.text_template)) ?? 0) > 1
            return (
              <div key={r.id} className="border-b border-[#1a1a1a] last:border-0 px-3 py-2 flex items-center gap-3 hover:bg-[#0d0d0d] transition-colors">
                <input type="checkbox" checked={selected.has(r.id)}
                  onChange={e => setSelected(prev => { const s = new Set(prev); e.target.checked ? s.add(r.id) : s.delete(r.id); return s })}
                  className="accent-violet-500 shrink-0" />
                <button onClick={() => openDetail(r)} className="flex-1 min-w-0 text-left">
                  <p className="text-xs text-white truncate">{r.text_template.split('\n')[0]}</p>
                </button>
                <div className="flex items-center gap-1 shrink-0 max-w-[220px] overflow-hidden">
                  {r.is_custom && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-400">custom</span>}
                  {isDup && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400" title="near-identical text exists">dup?</span>}
                  {r.niches.slice(0, 2).map(n => (
                    <span key={n} className={`text-[9px] px-1.5 py-0.5 rounded-full border ${badgeClass(n)}`}>{nicheEmoji(n)} {n}</span>
                  ))}
                  {r.tags.slice(0, 2).map(t => (
                    <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-[#1a1a1a] text-[#777]">{t}</span>
                  ))}
                </div>
                <span className="text-[10px] text-[#555] tabular-nums w-14 text-right shrink-0">♥ {r.likes_current}</span>
                <span className="text-[10px] text-[#555] tabular-nums w-16 text-right shrink-0">{r.jobs} used</span>
                <button onClick={() => setEditRow(r)} className="text-[10px] text-[#555] hover:text-white shrink-0">Edit</button>
                <button onClick={() => onGenerate({ id: r.id, text_template: r.text_template })}
                  className="text-[10px] font-semibold text-[#D41020] hover:text-red-400 shrink-0">Generate</button>
              </div>
            )
          })}
          {filtered.length === 0 && <p className="text-center text-xs text-[#444] py-10">No templates match</p>}
        </div>
      )}

      {/* Detail modal — original video like the Ideas page */}
      {detail && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4" onClick={() => setDetail(null)}>
          <div className="bg-[#111] border border-[#2a2a2a] rounded-2xl overflow-hidden max-w-3xl w-full flex max-h-[85vh]" onClick={e => e.stopPropagation()}>
            <div className="w-1/2 bg-black flex items-center justify-center">
              {detailLoading ? (
                <div className="w-5 h-5 border-2 border-[#333] border-t-white rounded-full animate-spin" />
              ) : detail.video_url ? (
                <video src={detail.video_url} controls autoPlay muted loop playsInline className="w-full max-h-[85vh] object-contain" />
              ) : (
                <p className="text-xs text-[#444] p-8 text-center">{detail.is_custom ? 'Custom template — no source video' : 'Video not available'}</p>
              )}
            </div>
            <div className="w-1/2 p-5 space-y-3 overflow-y-auto">
              <div className="flex items-center justify-between">
                <p className="text-xs text-[#666]">{detail.is_custom ? 'Custom' : `from @${detail.creator_username} · ♥ ${detail.likes_current}`}</p>
                <button onClick={() => setDetail(null)} className="text-[#555] hover:text-white text-lg leading-none">×</button>
              </div>
              <div className="bg-[#0a0a0a] rounded-lg px-3 py-3 space-y-1">
                {detail.text_template.split('\n').map((l, i) => <p key={i} className="text-sm text-white font-mono">{l}</p>)}
              </div>
              <div className="flex flex-wrap gap-1">
                {detail.niches.map(n => <span key={n} className={`text-[10px] px-1.5 py-0.5 rounded-full border ${badgeClass(n)}`}>{nicheEmoji(n)} {n}</span>)}
                {detail.tags.map(t => <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-[#1a1a1a] text-[#777]">{t}</span>)}
              </div>
              <p className="text-[10px] text-[#555]">{rows.find(r => r.id === detail.id)?.jobs ?? 0} videos generated · {rows.find(r => r.id === detail.id)?.posted ?? 0} posted</p>
              <button onClick={() => { onGenerate({ id: detail.id, text_template: detail.text_template }); setDetail(null) }}
                className="w-full bg-[#D41020] hover:bg-[#b50d1a] text-white text-xs font-semibold py-2 rounded-lg transition-colors">
                Generate →
              </button>
            </div>
          </div>
        </div>
      )}

      {(composer || editRow) && (
        <TemplateComposer
          contentTags={contentTags}
          allNiches={allNiches}
          existing={editRow}
          onClose={() => { setComposer(false); setEditRow(null) }}
          onSaved={async () => { setComposer(false); setEditRow(null); await fetchRows() }}
        />
      )}
    </div>
  )
}

function BulkAssign({ label, options, onApply, disabled }: {
  label: string; options: string[]; onApply: (v: string[]) => void; disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [vals, setVals] = useState<string[]>([])
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)} disabled={disabled} className="text-xs text-[#999] hover:text-white disabled:opacity-40">{label} ▾</button>
      {open && (
        <div className="absolute top-6 left-0 bg-[#161622] border border-[#2a2a2a] rounded-xl p-3 z-20 w-56">
          <div className="flex flex-wrap gap-1.5 mb-2">
            {options.map(o => (
              <button key={o} onClick={() => setVals(p => p.includes(o) ? p.filter(x => x !== o) : [...p, o])}
                className={`text-[10px] px-2 py-1 rounded border ${vals.includes(o) ? 'bg-violet-500/20 border-violet-500/50 text-violet-300' : 'border-[#2a2a2a] text-[#555]'}`}>
                {o}
              </button>
            ))}
          </div>
          <button onClick={() => { onApply(vals); setOpen(false); setVals([]) }}
            className="w-full bg-white text-black text-[10px] font-medium py-1.5 rounded-lg">Apply</button>
        </div>
      )}
    </div>
  )
}

const QUICK_EMOJI = ['🥺', '😏', '😈', '💦', '🍑', '❤️‍🔥', '🙈', '👀', '💋', '🔥', '😭', '🫦']

function TemplateComposer({ contentTags, allNiches, existing, onClose, onSaved }: {
  contentTags: string[]; allNiches: string[]; existing: CaptionTemplate | null
  onClose: () => void; onSaved: () => void
}) {
  const [text, setText] = useState(existing?.text_template ?? '')
  const [niches, setNiches] = useState<string[]>(existing?.niches ?? [])
  const [tags, setTags] = useState<string[]>(existing?.tags ?? [])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setErr(null)
    const res = existing
      ? await fetch(`/api/templates/${existing.id}/detail`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text_template: text, niches, tags }),
        })
      : await fetch('/api/templates/custom', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text_template: text, niches, tags }),
        })
    if (!res.ok) { setErr((await res.json()).error ?? 'save failed'); setSaving(false); return }
    setSaving(false)
    onSaved()
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-[#111] border border-[#2a2a2a] rounded-2xl p-6 w-full max-w-md space-y-3">
        <h3 className="text-sm font-semibold">{existing ? 'Edit template' : 'New custom template'}</h3>
        <div>
          <label className="text-xs text-[#666] block mb-1">
            Text on screen — one caption per line. <code className="text-[10px]">[placeholder]</code> is swapped per model,
            <code className="text-[10px]"> |40%</code> after a line sets its share of the video.
          </label>
          <textarea autoFocus value={text} onChange={e => setText(e.target.value)} rows={4}
            placeholder={'When [placeholder] hits different|60%\ncome watch me 🥺'}
            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2.5 text-xs text-white placeholder-[#444] focus:outline-none focus:border-[#444] font-mono" />
          <div className="flex flex-wrap gap-1 mt-1.5">
            <button type="button" onClick={() => setText(t => t + '[placeholder]')}
              className="text-[10px] px-2 py-1 rounded border border-[#2a2a2a] text-[#777] hover:text-white">+ [placeholder]</button>
            <button type="button" onClick={() => setText(t => t + '|40%')}
              className="text-[10px] px-2 py-1 rounded border border-[#2a2a2a] text-[#777] hover:text-white">+ |40%</button>
            {QUICK_EMOJI.map(e => (
              <button key={e} type="button" onClick={() => setText(t => t + e)} className="text-sm hover:scale-125 transition-transform">{e}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs text-[#666] block mb-1">Niches (required — drives matching)</label>
          <div className="flex flex-wrap gap-1.5">
            {allNiches.map(n => (
              <button key={n} type="button" onClick={() => setNiches(p => p.includes(n) ? p.filter(x => x !== n) : [...p, n])}
                className={`text-[10px] px-2 py-1 rounded border ${niches.includes(n) ? 'bg-violet-500/20 border-violet-500/50 text-violet-300' : 'border-[#2a2a2a] text-[#555] hover:text-white'}`}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs text-[#666] block mb-1">Content tags (limits which clips it can pair with)</label>
          <div className="flex flex-wrap gap-1.5">
            {contentTags.map(t => (
              <button key={t} type="button" onClick={() => setTags(p => p.includes(t) ? p.filter(x => x !== t) : [...p, t])}
                className={`text-[10px] px-2 py-1 rounded border ${tags.includes(t) ? 'bg-violet-500/20 border-violet-500/50 text-violet-300' : 'border-[#2a2a2a] text-[#555] hover:text-white'}`}>
                {t}
              </button>
            ))}
          </div>
        </div>
        {err && <p className="text-xs text-red-400">{err}</p>}
        <div className="flex gap-2 pt-1">
          <button onClick={save} disabled={saving || !text.trim() || niches.length === 0}
            className="flex-1 bg-white text-black text-xs font-medium py-2.5 rounded-lg hover:bg-[#e5e5e5] disabled:opacity-50 transition-colors">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onClose} className="flex-1 bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] text-xs py-2.5 rounded-lg hover:text-white transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
