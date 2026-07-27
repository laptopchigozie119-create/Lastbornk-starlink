import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiRouter } from './api.js'
import { paymentsRouter, paystackWebhook } from './payments.js'
import { configured as supabaseConfigured } from './supabase.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(__dirname, 'db.json')
const app = express()
app.set('trust proxy', 1)
app.use(helmet({ contentSecurityPolicy: false }))
app.use(cors({ origin: process.env.APP_URL || 'http://localhost:5173', credentials: true }))

// Paystack must receive an exact POST endpoint before express.json() mutates the
// payload. `/api/payments/webhook` is the canonical URL configured in Paystack;
// the two aliases keep older dashboard configurations working during rollout.
const paystackRawBody = express.raw({ type: 'application/json', limit: '1mb' })
app.post('/api/payments/webhook', paystackRawBody, paystackWebhook)
app.post('/api/payments/webhook/paystack', paystackRawBody, paystackWebhook)
app.post('/api/webhook', paystackRawBody, paystackWebhook)
app.use(express.json({ limit: '100kb' }))
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }))
app.use('/api/payments', paymentsRouter)
app.use('/api', apiRouter)

const readDb = async () => JSON.parse(await fs.readFile(DB_PATH, 'utf8'))
const writeDb = async (db) => fs.writeFile(DB_PATH, JSON.stringify(db, null, 2))
const id = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

app.get('/api/health', (_, res) => res.json({ ok: true }))

app.get('/api/dashboard', async (req, res) => {
  const db = await readDb()
  const user = db.users.find((u) => u.id === (req.query.userId || 'u1')) || db.users[0]
  res.json({
    user,
    nearby: db.hosts.filter((h) => h.online).slice(0, 3),
    bookings: db.bookings.filter((b) => b.userId === user.id).slice(0, 3),
    transactions: db.transactions.filter((t) => t.userId === user.id).slice(0, 4),
  })
})

app.get('/api/hosts', async (req, res) => {
  const db = await readDb()
  const { q = '', sort = 'distance', maxPrice } = req.query
  let hosts = db.hosts.filter((h) =>
    `${h.name} ${h.area} ${h.address}`.toLowerCase().includes(String(q).toLowerCase())
  )
  if (maxPrice) hosts = hosts.filter((h) => h.price <= Number(maxPrice))
  hosts.sort((a, b) => sort === 'price' ? a.price - b.price : sort === 'rating' ? b.rating - a.rating : a.distance - b.distance)
  res.json(hosts)
})

app.post('/api/hosts', async (req, res) => {
  const db = await readDb()
  const required = ['name', 'area', 'price', 'speed']
  if (required.some((key) => !req.body[key])) return res.status(400).json({ message: 'Name, area, price and speed are required.' })
  const host = {
    id: id('h'), ownerId: req.body.ownerId || 'u1', distance: 0,
    duration: '1 hour', rating: 5, reviews: 0, verified: false, online: true,
    spots: Number(req.body.spots || 5), avatar: req.body.name.slice(0, 2).toUpperCase(),
    amenities: req.body.amenities || ['Power backup'], ...req.body,
    price: Number(req.body.price), speed: Number(req.body.speed),
  }
  db.hosts.unshift(host)
  await writeDb(db)
  res.status(201).json(host)
})

app.patch('/api/hosts/:id', async (req, res) => {
  const db = await readDb()
  const index = db.hosts.findIndex((h) => h.id === req.params.id)
  if (index < 0) return res.status(404).json({ message: 'Listing not found.' })
  db.hosts[index] = { ...db.hosts[index], ...req.body }
  await writeDb(db)
  res.json(db.hosts[index])
})

app.get('/api/bookings', async (req, res) => {
  const db = await readDb()
  res.json(db.bookings.filter((b) => b.userId === (req.query.userId || 'u1')))
})

app.post('/api/bookings', async (req, res) => {
  const db = await readDb()
  const user = db.users.find((u) => u.id === (req.body.userId || 'u1'))
  const host = db.hosts.find((h) => h.id === req.body.hostId)
  const hours = Math.max(1, Number(req.body.hours || 1))
  if (!host || !user) return res.status(404).json({ message: 'User or hotspot not found.' })
  if (!host.online || host.spots < 1) return res.status(409).json({ message: 'This hotspot is currently unavailable.' })
  const amount = host.price * hours
  if (user.balance < amount) return res.status(402).json({ message: 'Your wallet balance is too low. Please add funds.' })
  user.balance -= amount
  host.spots -= 1
  const booking = { id: id('b'), userId: user.id, hostId: host.id, hostName: host.name, date: new Date().toISOString(), hours, amount, status: 'active', code: `LBK-${Math.floor(1000 + Math.random() * 9000)}` }
  db.bookings.unshift(booking)
  db.transactions.unshift({ id: id('t'), userId: user.id, type: 'debit', label: host.name, amount, date: booking.date })
  await writeDb(db)
  res.status(201).json({ booking, balance: user.balance })
})

// Demo-only top-up. Production always uses signed Paystack webhooks.
app.post('/api/wallet/topup', async (req, res) => {
  if (supabaseConfigured || process.env.NODE_ENV === 'production') return res.status(404).json({ message: 'Use /api/payments/initialize.' })
  const db = await readDb()
  const user = db.users.find((u) => u.id === (req.body.userId || 'u1'))
  const amount = Number(req.body.amount)
  if (!user || !Number.isFinite(amount) || amount < 100) return res.status(400).json({ message: 'Enter an amount of at least ₦100.' })
  user.balance += amount
  db.transactions.unshift({ id: id('t'), userId: user.id, type: 'credit', label: 'Wallet top-up', amount, date: new Date().toISOString() })
  await writeDb(db)
  res.json({ balance: user.balance })
})

app.patch('/api/profile', async (req, res) => {
  const db = await readDb()
  const user = db.users.find((u) => u.id === (req.body.userId || 'u1'))
  if (!user) return res.status(404).json({ message: 'User not found.' })
  Object.assign(user, req.body, { id: user.id, balance: user.balance })
  await writeDb(db)
  res.json(user)
})

const clientPath = path.join(__dirname, '..', 'dist')
app.use(express.static(clientPath))
app.get('*', async (req, res, next) => {
  if (req.path.startsWith('/api')) return next()
  try { await fs.access(path.join(clientPath, 'index.html')); res.sendFile(path.join(clientPath, 'index.html')) }
  catch { res.status(404).send('Run npm run build first, or use npm run dev.') }
})

app.use((error, req, res, _next) => {
  console.error(`[${req.method} ${req.path}]`, error)
  const status = error.status || (error.code === 'PGRST116' ? 404 : 500)
  res.status(status).json({ message: status === 500 && process.env.NODE_ENV === 'production' ? 'An internal error occurred.' : error.message })
})

export default app

// Start a long-running HTTP server only when this file is executed directly.
// Vercel imports the Express app from api/index.js as a serverless function.
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  const port = process.env.PORT || 4000
  app.listen(port, () => console.log(`Lastbornk API running at http://localhost:${port} (${supabaseConfigured ? 'Supabase' : 'demo JSON'} mode)`))
}
