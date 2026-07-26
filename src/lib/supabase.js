import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
export const supabase = url && key ? createClient(url, key) : null

export async function authHeaders() {
  if (!supabase) return { 'x-user-id': import.meta.env.VITE_DEV_USER_ID || 'u1' }
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
}

export async function secureApi(path, options = {}) {
  const response = await fetch(`${import.meta.env.VITE_API_URL || ''}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()), ...options.headers },
  })
  const body = response.status === 204 ? null : await response.json()
  if (!response.ok) throw new Error(body?.message || 'Request failed')
  return body
}
