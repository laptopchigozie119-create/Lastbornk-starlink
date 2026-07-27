import { createClient } from '@supabase/supabase-js'

// The project URL and publishable key are public client configuration. Vercel
// environment variables override these defaults when present.
const url = import.meta.env.VITE_SUPABASE_URL || 'https://spfbxjshmeshxvndpvqz.supabase.co'
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_FBVszbiIY1TDuS6Ncf3EAw_63jvQoGG'
export const supabase = url && key ? createClient(url, key) : null

export async function authHeaders() {
  if (!supabase) return { 'x-user-id': import.meta.env.VITE_DEV_USER_ID || 'u1' }
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
}

export async function secureApi(path, options = {}) {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData
  const response = await fetch(`${import.meta.env.VITE_API_URL || ''}${path}`, {
    ...options,
    headers: { ...(isFormData ? {} : { 'Content-Type': 'application/json' }), ...(await authHeaders()), ...options.headers },
  })
  const text = response.status === 204 ? '' : await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text ? { message: text } : null }
  if (!response.ok) throw new Error(body?.message || `Request failed (${response.status})`)
  return body
}
