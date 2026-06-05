import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  try {
    const { password } = await request.json()
    const sitePassword = process.env.SITE_PASSWORD
    const sessionSecret = process.env.SESSION_SECRET
    if (!sitePassword || !sessionSecret) return NextResponse.json({ error: 'Auth not configured' }, { status: 500 })
    if (password !== sitePassword) return NextResponse.json({ error: 'Wrong password' }, { status: 401 })
    const response = NextResponse.json({ ok: true })
    response.cookies.set('ft_auth', sessionSecret, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 60 * 60 * 24 * 30,
      path: '/',
    })
    return response
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true })
  response.cookies.delete('ft_auth')
  return response
}
