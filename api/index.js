import app from '../server/index.js'

// Vercel exposes this file as one serverless function. vercel.json forwards
// every /api/* request here and places the original trailing path in `path`.
export default function handler(req, res) {
  const incoming = new URL(req.url, 'http://localhost')
  const route = incoming.searchParams.get('path') || ''
  incoming.searchParams.delete('path')
  const query = incoming.searchParams.toString()
  req.url = `/api/${route}${query ? `?${query}` : ''}`
  return app(req, res)
}
