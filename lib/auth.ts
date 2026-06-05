import { cookies } from 'next/headers'

export const COOKIE_NAME = 'ft_auth'

export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies()
  const cookie = store.get(COOKIE_NAME)
  return cookie?.value === process.env.SESSION_SECRET
}
