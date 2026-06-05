'use client'
import { useEffect, useState } from 'react'

interface Stats { avgLikes: number; topLikes: number; totalPosts: number }

function fmt(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

export default function BenchmarkBar() {
  const [stats, setStats] = useState<Stats | null>(null)

  useEffect(() => {
    fetch('/api/stats').then(r => r.json()).then(setStats)
  }, [])

  if (!stats) return <div className="h-10 bg-[#111] border-b border-[#1e1e1e]" />

  return (
    <div className="bg-[#111] border-b border-[#1e1e1e] px-4 py-2 flex gap-6 text-xs text-[#666] overflow-x-auto whitespace-nowrap">
      <span>7-day avg likes: <strong className="text-[#999]">{fmt(stats.avgLikes)}</strong></span>
      <span>Top post: <strong className="text-[#999]">{fmt(stats.topLikes)}</strong></span>
      <span>Posts tracked: <strong className="text-[#999]">{stats.totalPosts}</strong></span>
    </div>
  )
}
