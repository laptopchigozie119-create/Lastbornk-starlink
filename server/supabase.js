import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY
const secretKey = process.env.SUPABASE_SECRET_KEY

export const configured = Boolean(url && publishableKey && secretKey)
export const supabaseAdmin = configured
  ? createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null

export function userClient(accessToken) {
  if (!configured) throw new Error('Supabase is not configured')
  return createClient(url, publishableKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
