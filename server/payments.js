import crypto from 'node:crypto'
import express from 'express'
import { requireUser } from './auth.js'
import { adminConfigured, supabaseAdmin } from './supabase.js'

export const paymentsRouter = express.Router()
const paystack = async (path, options = {}) => {
  if (!process.env.PAYSTACK_SECRET_KEY) throw Object.assign(new Error('Paystack is not configured.'), { status: 503 })
  const response = await fetch(`https://api.paystack.co${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json', ...options.headers },
  })
  const body = await response.json()
  if (!response.ok || !body.status) throw Object.assign(new Error(body.message || 'Paystack request failed.'), { status: 502 })
  return body.data
}

paymentsRouter.post('/initialize', requireUser, async (req, res, next) => {
  try {
    if (!adminConfigured) throw Object.assign(new Error('SUPABASE_SECRET_KEY is not configured on the server.'), { status: 503 })
    const amount = Number(req.body.amount)
    if (!Number.isFinite(amount) || amount < 100 || amount > 1_000_000) return res.status(400).json({ message: 'Amount must be between ₦100 and ₦1,000,000.' })
    const { data: profile, error: profileError } = await supabaseAdmin.from('users').select('email').eq('id', req.user.id).single()
    if (profileError) throw profileError
    if (!profile.email) return res.status(409).json({ message: 'Add an email address to your profile before funding your wallet.' })
    const { data: intent, error } = await supabaseAdmin.from('payment_intents').insert({ user_id: req.user.id, amount }).select().single()
    if (error) throw error
    const reference = `LBK_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`
    const data = await paystack('/transaction/initialize', {
      method: 'POST', body: JSON.stringify({
        email: profile.email,
        amount: Math.round(amount * 100), // Paystack expects kobo
        currency: 'NGN', reference,
        callback_url: `${process.env.APP_URL}/?payment=callback`,
        metadata: { user_id: req.user.id, payment_intent_id: intent.id, product: 'lastbornk_wallet' },
      }),
    })
    await supabaseAdmin.from('payment_intents').update({ reference }).eq('id', intent.id)
    res.json({ authorizationUrl: data.authorization_url, accessCode: data.access_code, reference })
  } catch (error) { next(error) }
})

paymentsRouter.get('/verify/:reference', requireUser, async (req, res, next) => {
  try {
    const data = await paystack(`/transaction/verify/${encodeURIComponent(req.params.reference)}`)
    if (data.status !== 'success' || data.currency !== 'NGN') return res.status(409).json({ status: data.status })
    if (data.metadata?.user_id !== req.user.id) return res.status(403).json({ message: 'Payment does not belong to this user.' })
    const { data: balance, error } = await supabaseAdmin.rpc('confirm_paystack_payment', {
      p_intent_id: data.metadata.payment_intent_id, p_reference: data.reference,
      p_amount: data.amount / 100, p_payload: data,
    })
    if (error) throw error
    res.json({ status: 'successful', balance })
  } catch (error) { next(error) }
})

// Mount BEFORE express.json(). Signature must be computed over the exact raw request body.
export async function paystackWebhook(req, res, next) {
  try {
    const signature = String(req.headers['x-paystack-signature'] || '')
    const expected = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY || '').update(req.body).digest('hex')
    if (!signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return res.status(401).send('Invalid signature')
    }
    const event = JSON.parse(req.body.toString('utf8'))
    if (event.event === 'charge.success' && event.data?.status === 'success' && event.data?.currency === 'NGN') {
      const intentId = event.data.metadata?.payment_intent_id
      if (intentId) {
        const { error } = await supabaseAdmin.rpc('confirm_paystack_payment', {
          p_intent_id: intentId, p_reference: event.data.reference,
          p_amount: event.data.amount / 100, p_payload: event.data,
        })
        if (error) throw error
      }
    }
    // Paystack retries non-200 deliveries. The database RPC is idempotent for duplicate events.
    return res.sendStatus(200)
  } catch (error) { next(error) }
}
