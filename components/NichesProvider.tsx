'use client'
import { createContext, useContext, useState, useEffect, useCallback } from 'react'

export interface NicheDef {
  name: string
  emoji: string
  color_key: string
  sort_order: number
}

export const COLOR_CLASSES: Record<string, { badge: string; dot: string }> = {
  blue:    { badge: 'bg-blue-500/10 border-blue-500/20 text-blue-400',       dot: 'bg-blue-500' },
  pink:    { badge: 'bg-pink-500/10 border-pink-500/20 text-pink-400',       dot: 'bg-pink-500' },
  purple:  { badge: 'bg-purple-500/10 border-purple-500/20 text-purple-400', dot: 'bg-purple-500' },
  rose:    { badge: 'bg-rose-500/10 border-rose-500/20 text-rose-400',       dot: 'bg-rose-500' },
  emerald: { badge: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400', dot: 'bg-emerald-500' },
  amber:   { badge: 'bg-amber-500/10 border-amber-500/20 text-amber-400',    dot: 'bg-amber-500' },
  teal:    { badge: 'bg-teal-500/10 border-teal-500/20 text-teal-400',       dot: 'bg-teal-500' },
  orange:  { badge: 'bg-orange-500/10 border-orange-500/20 text-orange-400', dot: 'bg-orange-500' },
  sky:     { badge: 'bg-sky-500/10 border-sky-500/20 text-sky-400',          dot: 'bg-sky-500' },
  lime:    { badge: 'bg-lime-500/10 border-lime-500/20 text-lime-400',       dot: 'bg-lime-500' },
  violet:  { badge: 'bg-violet-500/10 border-violet-500/20 text-violet-400', dot: 'bg-violet-500' },
  red:     { badge: 'bg-red-500/10 border-red-500/20 text-red-400',          dot: 'bg-red-500' },
  indigo:  { badge: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-400', dot: 'bg-indigo-500' },
  cyan:    { badge: 'bg-cyan-500/10 border-cyan-500/20 text-cyan-400',       dot: 'bg-cyan-500' },
  yellow:  { badge: 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400', dot: 'bg-yellow-500' },
}

const FALLBACK = { badge: 'bg-[#1a1a1a] border-[#2a2a2a] text-[#666]', dot: 'bg-[#444]' }

interface NichesContextValue {
  niches: NicheDef[]
  isLoaded: boolean
  badgeClass: (name: string) => string
  dotClass: (name: string) => string
  nicheEmoji: (name: string) => string
  addNiche: (name: string, emoji: string) => Promise<void>
  deleteNiche: (name: string) => Promise<void>
}

const NichesContext = createContext<NichesContextValue>({
  niches: [],
  isLoaded: false,
  badgeClass: () => FALLBACK.badge,
  dotClass: () => FALLBACK.dot,
  nicheEmoji: () => '',
  addNiche: async () => {},
  deleteNiche: async () => {},
})

export function useNiches() {
  return useContext(NichesContext)
}

export function NichesProvider({ children }: { children: React.ReactNode }) {
  const [niches, setNiches] = useState<NicheDef[]>([])
  const [isLoaded, setIsLoaded] = useState(false)

  const refresh = useCallback(async () => {
    const res = await fetch('/api/niches')
    const data = await res.json()
    setNiches(data.niches ?? [])
    setIsLoaded(true)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  function lookup(name: string) {
    const n = niches.find(x => x.name === name)
    return n ? (COLOR_CLASSES[n.color_key] ?? FALLBACK) : FALLBACK
  }

  async function addNiche(name: string, emoji: string) {
    await fetch('/api/niches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, emoji }),
    })
    await refresh()
  }

  async function deleteNiche(name: string) {
    await fetch('/api/niches', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    await refresh()
  }

  return (
    <NichesContext.Provider value={{
      niches,
      isLoaded,
      badgeClass: (name) => lookup(name).badge,
      dotClass: (name) => lookup(name).dot,
      nicheEmoji: (name) => niches.find(x => x.name === name)?.emoji ?? '',
      addNiche,
      deleteNiche,
    }}>
      {children}
    </NichesContext.Provider>
  )
}
