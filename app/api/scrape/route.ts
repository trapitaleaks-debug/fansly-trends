import { NextResponse } from 'next/server'

const OWNER = 'trapitaleaks-debug'
const REPO = 'fansly-trends'
const WORKFLOW = 'scrape.yml'

export async function POST() {
  const token = process.env.GITHUB_PAT
  if (!token) return NextResponse.json({ error: 'GITHUB_PAT not configured' }, { status: 500 })

  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    }
  )

  if (!res.ok) {
    const text = await res.text()
    return NextResponse.json({ error: text }, { status: res.status })
  }

  return NextResponse.json({
    ok: true,
    url: `https://github.com/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}`,
  })
}
