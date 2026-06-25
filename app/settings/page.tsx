'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface BlacklistEntry {
  username: string
  added_at: string
}

export default function SettingsPage() {
  const [blacklist, setBlacklist] = useState<BlacklistEntry[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [scraping, setScraping] = useState(false)
  const [scrapeResult, setScrapeResult] = useState<{ ok: boolean; url?: string; error?: string } | null>(null)

  async function runScraper() {
    setScraping(true)
    setScrapeResult(null)
    try {
      const res = await fetch('/api/scrape', { method: 'POST' })
      const data = await res.json()
      setScrapeResult(res.ok ? { ok: true, url: data.url } : { ok: false, error: data.error ?? 'Unknown error' })
    } catch {
      setScrapeResult({ ok: false, error: 'Network error' })
    } finally {
      setScraping(false)
    }
  }

  async function load() {
    const res = await fetch('/api/settings')
    const data = await res.json()
    setBlacklist(data.blacklist ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function addUsername() {
    const username = input.trim().replace(/^@/, '')
    if (!username) return
    setAdding(true)
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    })
    setInput('')
    setAdding(false)
    load()
  }

  async function removeUsername(username: string) {
    setRemoving(username)
    await fetch('/api/settings', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    })
    setRemoving(null)
    load()
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#aaa]">
      <nav className="bg-[#0f0f0f] border-b border-[#1e1e1e] px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <span className="text-white font-semibold text-sm">FanslyTrends</span>
        <div className="flex gap-6 text-sm text-[#666]">
          <Link href="/" className="hover:text-white transition-colors">Feed</Link>
          <Link href="/ideas" className="hover:text-white transition-colors">Ideas</Link>
          <Link href="/models" className="hover:text-white transition-colors">Models</Link>
          <Link href="/generated" className="hover:text-white transition-colors">Generated</Link>
          <span className="text-white">Settings</span>
        </div>
      </nav>

      <div className="max-w-2xl mx-auto px-4 py-8">

        {/* Scraper */}
        <div className="mb-10">
          <h1 className="text-white text-lg font-semibold mb-1">Scraper</h1>
          <p className="text-[#555] text-sm mb-4">
            Trigger a fresh FYP scrape on GitHub Actions. Results arrive via Telegram in ~10–15 min.
          </p>
          <div className="flex items-center gap-4">
            <button
              onClick={runScraper}
              disabled={scraping}
              className="bg-white text-black px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-40 hover:bg-[#e0e0e0] transition-colors"
            >
              {scraping ? 'Starting…' : 'Run Scraper'}
            </button>
            {scrapeResult && (
              scrapeResult.ok ? (
                <span className="text-green-400 text-sm">
                  ✓ Started —{' '}
                  <a href={scrapeResult.url} target="_blank" rel="noreferrer" className="underline">
                    view run
                  </a>
                </span>
              ) : (
                <span className="text-red-400 text-sm">✗ {scrapeResult.error}</span>
              )
            )}
          </div>
        </div>

        <div className="border-t border-[#1a1a1a] mb-8" />

        <h1 className="text-white text-lg font-semibold mb-1">Banned Creators</h1>
        <p className="text-[#555] text-sm mb-6">
          Creators in this list are filtered out from the scraper — their posts will never appear in the feed.
        </p>

        {/* Add input */}
        <div className="flex gap-2 mb-8">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addUsername()}
            placeholder="@username or username"
            className="flex-1 bg-[#111] border border-[#222] rounded-lg px-3 py-2 text-sm text-white placeholder-[#444] focus:outline-none focus:border-[#444]"
          />
          <button
            onClick={addUsername}
            disabled={adding || !input.trim()}
            className="bg-white text-black px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-40 hover:bg-[#e0e0e0] transition-colors"
          >
            {adding ? 'Adding…' : 'Ban'}
          </button>
        </div>

        {/* List */}
        {loading ? (
          <p className="text-[#444] text-sm">Loading…</p>
        ) : blacklist.length === 0 ? (
          <p className="text-[#444] text-sm">No banned creators yet.</p>
        ) : (
          <div className="space-y-1">
            <p className="text-[#555] text-xs mb-3">{blacklist.length} banned</p>
            {blacklist.map(entry => (
              <div
                key={entry.username}
                className="flex items-center justify-between bg-[#111] border border-[#1a1a1a] rounded-lg px-3 py-2"
              >
                <div>
                  <span className="text-white text-sm">@{entry.username}</span>
                  <span className="text-[#444] text-xs ml-3">
                    {new Date(entry.added_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </span>
                </div>
                <button
                  onClick={() => removeUsername(entry.username)}
                  disabled={removing === entry.username}
                  className="text-[#555] hover:text-red-400 text-xs transition-colors disabled:opacity-40"
                >
                  {removing === entry.username ? 'Removing…' : 'Remove'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
