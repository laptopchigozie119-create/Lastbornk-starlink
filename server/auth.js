import { configured, supabaseAuth } from './supabase.js'

export async function requireUser(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (token && configured) {
      const { data, error } = await supabaseAuth.auth.getUser(token)
      if (error || !data.user) return res.status(401).json({ message: 'Invalid or expired session.' })
      req.user = data.user
      req.accessToken = token
      return next()
    }
    if (process.env.DEV_BYPASS_AUTH === 'true' && process.env.NODE_ENV !== 'production') {
      req.user = { id: req.headers['x-user-id'] || process.env.DEV_USER_ID, email: 'dev@lastbornk.ng' }
      req.accessToken = null
      return next()
    }
    return res.status(401).json({ message: 'Sign in is required.' })
  } catch (error) { next(error) }
}

export function requireAdmin(req, res, next) {
  const provided = req.headers['x-admin-key']
  if (!process.env.ADMIN_API_KEY || provided !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({ message: 'Admin access required.' })
  }
  next()
}
