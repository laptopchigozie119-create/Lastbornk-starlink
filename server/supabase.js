import { createClient } from '@supabase/supabase-js'

// Supabase URL and publishable key are public project identifiers. Environment
// variables override these defaults; only SUPABASE_SECRET_KEY is confidential.
const url = process.env.SUPABASE_URL || 'https://spfbxjshmeshxvndpvqz.supabase.co'
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_FBVszbiIY1TDuS6Ncf3EAw_63jvQoGG'
const secretKey = process.env.SUPABASE_SECRET_KEY

export const configured = Boolean(url && publishableKey)
export const adminConfigured = Boolean(url && secretKey)
export const supabaseAuth = configured
  ? createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null
export const supabaseAdmin = adminConfigured
  ? createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null

export function userClient(accessToken) {
  if (!configured) throw new Error('Supabase is not configured')
  return createClient(url, publishableKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
