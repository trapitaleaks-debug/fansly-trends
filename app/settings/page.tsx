'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'

interface BlacklistEntry { username: string; added_at: string }

export default function SettingsPage() {
  const [blacklist, setBlacklist] = useState<BlacklistEntry[]>([])
  const [newUsername, setNewUsername] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => { setBlacklist(data.blacklist ?? []); setLoading(false) })
  }, [])

  async function addUsername(e: React.FormEvent) {
    e.preventDefault()
    if (!newUsername.trim()) return
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: newUsername.trim() }),
    })
    setBlacklist(prev => [{ username: newUsername.trim().toLowerCase(), added_at: new Date().toISOString() }, ...prev])
    setNewUsername('')
  }

  async function removeUsername(username: string) {
    await fetch('/api/settings', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    })
    setBlacklist(prev => prev.filter(e => e.username !== username))
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <nav className="bg-[#0f0f0f] border-b border-[#1e1e1e] px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <h1 className="text-sm font-bold text-white">FanslyTrends</h1>
        <div className="flex gap-4 text-xs text-[#666]">
          <Link href="/" className="hover:text-white transition-colors">Feed</Link>
          <Link href="/ideas" className="hover:text-white transition-colors">Ideas</Link>
          <Link href="/models" className="hover:text-white transition-colors">Models</Link>
          <span className="text-white">Settings</span>
          <Link href="/pipeline" className="hover:text-white transition-colors">Pipeline</Link>
        </div>
      </nav>

      <div className="max-w-lg mx-auto px-4 py-8">
        <h2 className="text-base font-semibold mb-1">Scraper Blacklist</h2>
        <p className="text-xs text-[#666] mb-5">Fansly usernames to exclude from the daily scrape. Add your own models here.</p>

        <form onSubmit={addUsername} className="flex gap-2 mb-6">
          <input
            type="text"
            value={newUsername}
            onChange={e => setNewUsername(e.target.value)}
            placeholder="fansly_username"
            className="flex-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-sm text-white placeholder-[#444] focus:outline-none focus:border-[#444]"
          />
          <button
            type="submit"
            disabled={!newUsername.trim()}
            className="bg-[#1e1e1e] border border-[#2a2a2a] text-sm px-4 py-2 rounded-lg hover:border-[#444] disabled:opacity-40 transition-colors"
          >
            Add
          </button>
        </form>

        {loading ? (
          <div className="text-[#444] text-sm">Loading...</div>
        ) : blacklist.length === 0 ? (
          <p className="text-[#444] text-sm">No usernames blacklisted yet.</p>
        ) : (
          <div className="space-y-2">
            {blacklist.map(entry => (
              <div key={entry.username} className="flex items-center justify-between bg-[#111] border border-[#1e1e1e] rounded-lg px-4 py-3">
                <span className="text-sm text-[#ccc]">@{entry.username}</span>
                <button
                  onClick={() => removeUsername(entry.username)}
                  className="text-xs text-[#555] hover:text-red-400 transition-colors"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
