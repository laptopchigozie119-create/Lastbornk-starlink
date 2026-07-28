import express from 'express'
import crypto from 'node:crypto'
import multer from 'multer'
import dns from 'node:dns/promises'
import net from 'node:net'
import { requireAdmin, requireUser } from './auth.js'
import { adminConfigured, configured, supabaseAdmin, userClient } from './supabase.js'

export const apiRouter = express.Router()
const ensure = () => { if (!configured) throw Object.assign(new Error('Supabase is not configured. Copy .env.example to .env.'), { status: 503 }) }
const dbFor = (req) => req.accessToken ? userClient(req.accessToken) : supabaseAdmin
const validMac = (value) => !value || /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(value)
// Physical provisioning requires an explicit two-variable opt-in. This keeps the
// working simulation active even if an old Vercel deployment accidentally has
// MOCK_ROUTER_ENABLED=false. Real hardware starts only when both settings agree.
const physicalRouterLive = process.env.PHYSICAL_ROUTER_LIVE === 'true'
const mockRouterEnabled = process.env.MOCK_ROUTER_ENABLED !== 'false' || !physicalRouterLive
const CHAT_BUCKET = 'chat-attachments'
const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, done) => {
    const mime = file.mimetype.split(';')[0]
    const allowed = /^(image\/(jpeg|png|gif|webp)|audio\/(mpeg|mp4|ogg|wav|webm)|video\/(mp4|webm)|application\/(pdf|zip|msword|vnd\.openxmlformats-officedocument\..+)|text\/plain)$/i.test(mime)
    done(allowed ? null : Object.assign(new Error('Unsupported attachment type.'), { status: 415 }), allowed)
  },
})

const credentialsKey = () => {
  const raw=process.env.ROUTER_CREDENTIALS_KEY
  if(!raw)throw Object.assign(new Error('ROUTER_CREDENTIALS_KEY is not configured.'),{status:503})
  const decoded=Buffer.from(raw,'base64')
  return decoded.length===32?decoded:crypto.createHash('sha256').update(raw).digest()
}
const encryptSecret = value => {if(!value)return null;const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',credentialsKey(),iv);const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return [iv.toString('base64'),cipher.getAuthTag().toString('base64'),encrypted.toString('base64')].join('.')}
const decryptSecret = value => {if(!value)return '';const[iv,tag,data]=value.split('.').map(v=>Buffer.from(v,'base64'));const decipher=crypto.createDecipheriv('aes-256-gcm',credentialsKey(),iv);decipher.setAuthTag(tag);return Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8')}
const isPrivateIp = ip => net.isIP(ip)&&(ip==='127.0.0.1'||ip==='::1'||ip.startsWith('10.')||ip.startsWith('192.168.')||ip.startsWith('169.254.')||/^172\.(1[6-9]|2\d|3[01])\./.test(ip)||ip.startsWith('fc')||ip.startsWith('fd'))
async function validateControllerUrl(value){const url=new URL(value);if(url.protocol!=='https:')throw Object.assign(new Error('Controller URL must use HTTPS.'),{status:400});const addresses=await dns.lookup(url.hostname,{all:true});if(!addresses.length||addresses.some(item=>isPrivateIp(item.address)))throw Object.assign(new Error('Controller URL must resolve to a public address. Use RADIUS for private routers.'),{status:400});return url.toString()}

export const generateVoucherPin = () => String(crypto.randomInt(100000, 1000000))

async function assignMockVoucherPin(sessionId) {
  if (!adminConfigured) throw Object.assign(new Error('SUPABASE_SECRET_KEY is required for mock router activation.'), { status: 503 })

  // access_code is unique. A collision is unlikely, but retry rather than
  // exposing an intermittent failure during concurrent voucher purchases.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const pin = generateVoucherPin()
    const { data, error } = await supabaseAdmin
      .from('vouchers_sessions')
      .update({ access_code: pin, status: 'active' })
      .eq('id', sessionId)
      .select('*')
      .single()

    if (!error) return data
    if (error.code !== '23505') throw error
  }

  throw Object.assign(new Error('Could not allocate a unique voucher PIN. Please retry.'), { status: 503 })
}

async function activateRouter(session,hostId) {
  const activatedSession=await assignMockVoucherPin(session.id)
  if(mockRouterEnabled)return{session:activatedSession,activation:{success:true,simulated:true,provider:'mock-mikrotik',activatedAt:new Date().toISOString(),message:'Mock router activated successfully.'}}

  const{data:config,error}=await supabaseAdmin.from('hardware_configs').select('*').eq('host_id',hostId).eq('enabled',true).single()
  if(error)throw Object.assign(new Error('No enabled physical-router configuration exists for this hotspot.'),{status:409})
  const payload={event:'voucher.activate',jobVersion:1,hostId,routerIdentity:config.router_identity,sessionId:activatedSession.id,pin:activatedSession.access_code,clientMac:activatedSession.client_mac,speedProfile:activatedSession.speed_limit_profile,startsAt:activatedSession.starts_at,expiresAt:activatedSession.expires_at}
  const{data:job,error:jobError}=await supabaseAdmin.from('router_provision_jobs').upsert({host_id:hostId,session_id:activatedSession.id,hardware_config_id:config.id,status:config.integration_mode==='radius'?'ready':'pending',payload},{onConflict:'session_id'}).select().single();if(jobError)throw jobError

  if(config.integration_mode==='radius')return{session:activatedSession,activation:{success:true,simulated:false,provider:'radius',jobId:job.id,status:'ready',message:'Voucher is ready for RADIUS authentication.'}}
  try{
    const secret=decryptSecret(config.encrypted_secret),body=JSON.stringify(payload),signature=crypto.createHmac('sha256',secret).update(body).digest('hex')
    const response=await fetch(config.controller_url,{method:'POST',headers:{'content-type':'application/json','x-lastbornk-signature':signature,'x-lastbornk-router':config.router_identity,...(config.api_username?{'x-lastbornk-user':config.api_username}:{})},body,signal:AbortSignal.timeout(8000)})
    if(!response.ok)throw new Error(`Controller returned HTTP ${response.status}`)
    await supabaseAdmin.from('router_provision_jobs').update({status:'delivered',attempts:1,delivered_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',job.id)
    return{session:activatedSession,activation:{success:true,simulated:false,provider:'controller_webhook',jobId:job.id,status:'delivered',message:'Voucher delivered to the router controller.'}}
  }catch(cause){
    await supabaseAdmin.from('router_provision_jobs').update({status:'failed',attempts:1,last_error:String(cause.message).slice(0,500),updated_at:new Date().toISOString()}).eq('id',job.id)
    return{session:activatedSession,activation:{success:false,simulated:false,provider:'controller_webhook',jobId:job.id,status:'failed',message:'Voucher saved, but controller delivery failed. Retry from the host dashboard.'}}
  }
}

async function purchaseOwnMockHotspot({ userId, host, clientMac, durationMinutes, speedProfile }) {
  if (!adminConfigured) throw Object.assign(new Error('SUPABASE_SECRET_KEY is required for mock voucher purchases.'), { status: 503 })
  const { data: profile, error: profileError } = await supabaseAdmin.from('users').select('wallet_balance').eq('id', userId).single()
  if (profileError) throw profileError
  const fee = Number(host.voucher_fee)
  const oldBalance = Number(profile.wallet_balance)
  const oldEarnings = Number(host.total_earnings || 0)
  if (oldBalance < fee) throw Object.assign(new Error('Insufficient wallet balance. Add money before buying this voucher.'), { status: 402 })
  if (!host.is_online) throw Object.assign(new Error('This hotspot is currently unavailable.'), { status: 409 })

  let session = null
  for (let attempt = 0; attempt < 8 && !session; attempt += 1) {
    const { data, error } = await supabaseAdmin.from('vouchers_sessions').insert({
      user_id: userId,
      host_id: host.id,
      access_code: generateVoucherPin(),
      client_mac: clientMac || null,
      speed_limit_profile: speedProfile,
      amount_paid: fee,
      expires_at: new Date(Date.now() + durationMinutes * 60_000).toISOString(),
      status: 'active',
    }).select('*').single()
    if (!error) session = data
    else if (error.code !== '23505') throw error
  }
  if (!session) throw Object.assign(new Error('Could not allocate a unique voucher PIN. Please retry.'), { status: 503 })

  const newBalance = oldBalance - fee
  const newEarnings = oldEarnings + fee
  const rollback = async () => {
    await supabaseAdmin.from('transactions').delete().eq('session_id', session.id)
    await supabaseAdmin.from('vouchers_sessions').delete().eq('id', session.id)
    await supabaseAdmin.from('users').update({ wallet_balance: oldBalance }).eq('id', userId).eq('wallet_balance', newBalance)
    await supabaseAdmin.from('hosts').update({ total_earnings: oldEarnings }).eq('id', host.id).eq('total_earnings', newEarnings)
  }

  const { data: debited, error: debitError } = await supabaseAdmin.from('users').update({ wallet_balance: newBalance }).eq('id', userId).eq('wallet_balance', oldBalance).select('wallet_balance').maybeSingle()
  if (debitError || !debited) {
    await supabaseAdmin.from('vouchers_sessions').delete().eq('id', session.id)
    throw debitError || Object.assign(new Error('Your wallet changed during purchase. Please retry.'), { status: 409 })
  }

  const { data: credited, error: earningError } = await supabaseAdmin.from('hosts').update({ total_earnings: newEarnings }).eq('id', host.id).eq('total_earnings', oldEarnings).select('total_earnings').maybeSingle()
  if (earningError || !credited) {
    await rollback()
    throw earningError || Object.assign(new Error('The host balance changed during purchase. Please retry.'), { status: 409 })
  }

  const { error: transactionError } = await supabaseAdmin.from('transactions').insert([
    { user_id: userId, host_id: host.id, session_id: session.id, type: 'voucher_debit', amount: fee, balance_after: newBalance, metadata: { mock_self_hosted_purchase: true } },
    { user_id: host.user_id, host_id: host.id, session_id: session.id, type: 'host_earning', amount: fee, balance_after: null, metadata: { mock_self_hosted_purchase: true } },
  ])
  if (transactionError) { await rollback(); throw transactionError }
  return session
}

// Called by FreeRADIUS rlm_rest, never by a browser or router client.
apiRouter.post('/network/authorize', async (req,res,next)=>{
  try{
    ensure();const supplied=String(req.headers['x-network-secret']||''),expected=String(process.env.NETWORK_SHARED_SECRET||'')
    if(!expected||supplied.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))return res.status(401).json({message:'Unauthorized network controller.'})
    const{username,password,callingStationId,nasIdentifier}=req.body
    if(!username||username!==password)return res.status(401).json({accept:false})
    const{data:session,error}=await supabaseAdmin.from('vouchers_sessions').select('*, hosts!inner(router_identity,is_online)').eq('access_code',username).eq('status','active').gt('expires_at',new Date().toISOString()).single()
    if(error||!session||!session.hosts.is_online||session.hosts.router_identity!==nasIdentifier)return res.status(401).json({accept:false})
    if(session.client_mac&&callingStationId&&String(session.client_mac).toLowerCase()!==String(callingStationId).replace(/-/g,':').toLowerCase())return res.status(401).json({accept:false})
    if(!session.client_mac&&callingStationId&&validMac(String(callingStationId).replace(/-/g,':')))await supabaseAdmin.from('vouchers_sessions').update({client_mac:String(callingStationId).replace(/-/g,':')}).eq('id',session.id)
    const seconds=Math.max(1,Math.floor((new Date(session.expires_at)-Date.now())/1000))
    await Promise.all([supabaseAdmin.from('hardware_configs').update({last_seen_at:new Date().toISOString(),last_error:null}).eq('host_id',session.host_id),supabaseAdmin.from('router_provision_jobs').update({status:'delivered',delivered_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('session_id',session.id)])
    res.json({'control:Auth-Type':{'type':'string','value':['Accept']},'reply:Mikrotik-Rate-Limit':{'type':'string','value':[session.speed_limit_profile]},'reply:Session-Timeout':{'type':'integer','value':[seconds]},'control:Simultaneous-Use':{'type':'integer','value':[1]}})
  }catch(e){next(e)}
})

apiRouter.get('/me', requireUser, async (req, res, next) => {
  try { ensure(); const { data, error } = await dbFor(req).from('users').select('*').eq('id', req.user.id).single(); if (error) throw error; res.json(data) } catch (e) { next(e) }
})
apiRouter.get('/transactions', requireUser, async (req, res, next) => {
  try { ensure(); const { data, error } = await dbFor(req).from('transactions').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(50); if (error) throw error; res.json(data) } catch (e) { next(e) }
})

apiRouter.patch('/profile', requireUser, async (req,res,next)=>{
  try{
    ensure();const name=String(req.body.name||'').trim(),phone=String(req.body.phone||'').trim(),email=String(req.body.email||'').trim()
    if(name.length<2||name.length>80)return res.status(400).json({message:'Name must be between 2 and 80 characters.'})
    const update={name};if(phone)update.phone=phone;if(email)update.email=email
    const{data,error}=await dbFor(req).from('users').update(update).eq('id',req.user.id).select('*').single();if(error)throw error
    if(adminConfigured){await supabaseAdmin.auth.admin.updateUserById(req.user.id,{user_metadata:{name},...(email?{email}:{})})}
    res.json({...data,balance:Number(data.wallet_balance)})
  }catch(e){next(e)}
})

apiRouter.get('/payments/methods',requireUser,async(req,res,next)=>{
  try{
    ensure();if(!adminConfigured)throw Object.assign(new Error('SUPABASE_SECRET_KEY is required for payment methods.'),{status:503})
    const{data,error}=await supabaseAdmin.from('payment_intents').select('id,provider,provider_payload,paid_at').eq('user_id',req.user.id).eq('status','successful').order('paid_at',{ascending:false}).limit(25);if(error)throw error
    const seen=new Set(),methods=[]
    for(const row of data||[]){const auth=row.provider_payload?.authorization;if(!auth?.last4)continue;const fingerprint=auth.signature||`${auth.bin}:${auth.last4}:${auth.exp_month}:${auth.exp_year}`;if(seen.has(fingerprint))continue;seen.add(fingerprint);methods.push({id:row.id,provider:row.provider||'paystack',brand:auth.brand||auth.card_type||'Card',last4:auth.last4,bank:auth.bank||'',expMonth:auth.exp_month||'',expYear:auth.exp_year||'',reusable:Boolean(auth.reusable)})}
    res.json(methods)
  }catch(e){next(e)}
})

apiRouter.get('/hosts/mine', requireUser, async (req,res,next)=>{
  try{ensure();const{data,error}=await dbFor(req).from('hosts').select('*').eq('user_id',req.user.id).maybeSingle();if(error)throw error;res.json(data)}catch(e){next(e)}
})
apiRouter.get('/hardware/config',requireUser,async(req,res,next)=>{
  try{ensure();if(!adminConfigured)throw Object.assign(new Error('SUPABASE_SECRET_KEY is required for hardware configuration.'),{status:503});const{data:host,error:hostError}=await supabaseAdmin.from('hosts').select('id').eq('user_id',req.user.id).single();if(hostError)throw hostError;const{data,error}=await supabaseAdmin.from('hardware_configs').select('id,host_id,router_type,integration_mode,router_address,controller_url,router_identity,api_username,enabled,last_seen_at,last_error,updated_at').eq('host_id',host.id).maybeSingle();if(error)throw error;res.json(data)}catch(e){next(e)}
})
apiRouter.put('/hardware/config',requireUser,async(req,res,next)=>{
  try{
    ensure();if(!adminConfigured)throw Object.assign(new Error('SUPABASE_SECRET_KEY is required for hardware configuration.'),{status:503})
    const{data:host,error:hostError}=await supabaseAdmin.from('hosts').select('id').eq('user_id',req.user.id).single();if(hostError)throw hostError
    const routerType=String(req.body.routerType||'mikrotik'),mode=String(req.body.integrationMode||'radius'),identity=String(req.body.routerIdentity||'').trim()
    if(!['mikrotik','openwrt','unifi','other'].includes(routerType)||!['radius','controller_webhook'].includes(mode)||!identity)return res.status(400).json({message:'Valid router type, integration mode and router identity are required.'})
    const controllerUrl=mode==='controller_webhook'?await validateControllerUrl(req.body.controllerUrl):null
    let encryptedSecret
    if(req.body.apiSecret)encryptedSecret=encryptSecret(String(req.body.apiSecret))
    const values={host_id:host.id,router_type:routerType,integration_mode:mode,router_address:String(req.body.routerAddress||'').trim()||null,controller_url:controllerUrl,router_identity:identity,api_username:String(req.body.apiUsername||'').trim()||null,enabled:Boolean(req.body.enabled),updated_at:new Date().toISOString(),...(encryptedSecret?{encrypted_secret:encryptedSecret}:{})}
    const{data,error}=await supabaseAdmin.from('hardware_configs').upsert(values,{onConflict:'host_id'}).select('id,host_id,router_type,integration_mode,router_address,controller_url,router_identity,api_username,enabled,last_seen_at,last_error,updated_at').single();if(error)throw error
    await supabaseAdmin.from('hosts').update({router_identity:identity}).eq('id',host.id)
    res.json(data)
  }catch(e){if(['42P01','PGRST204'].includes(e.code))return res.status(503).json({message:'Apply migration 004_hardware_integration.sql in Supabase first.'});next(e)}
})

apiRouter.post('/hosts', requireUser, async (req,res,next)=>{
  try{ensure();const h=req.body;if(!h.businessName||!validMac(h.routerMac)||!Number.isFinite(Number(h.latitude))||!Number.isFinite(Number(h.longitude)))return res.status(400).json({message:'Business name, router MAC and valid coordinates are required.'});const{data,error}=await dbFor(req).from('hosts').insert({user_id:req.user.id,business_name:h.businessName,latitude:Number(h.latitude),longitude:Number(h.longitude),address:h.address,router_mac:h.routerMac,voucher_fee:Number(h.voucherFee||300),speed_mbps:Number(h.speedMbps||50),capacity:Number(h.capacity||10),is_online:Boolean(h.isOnline)}).select().single();if(error)throw error;res.status(201).json(data)}catch(e){next(e)}
})
apiRouter.patch('/hosts/:id', requireUser, async (req,res,next)=>{
  try{ensure();const allowed={};for(const [from,to] of [['businessName','business_name'],['address','address'],['voucherFee','voucher_fee'],['speedMbps','speed_mbps'],['capacity','capacity'],['isOnline','is_online']])if(req.body[from]!==undefined)allowed[to]=req.body[from];const{data,error}=await dbFor(req).from('hosts').update(allowed).eq('id',req.params.id).eq('user_id',req.user.id).select().single();if(error)throw error;res.json(data)}catch(e){next(e)}
})

apiRouter.get('/hosts/nearby', requireUser, async (req, res, next) => {
  try {
    ensure(); const lat=Number(req.query.lat), lng=Number(req.query.lng), radius=Math.min(Number(req.query.radius||10000),50000)
    if (!Number.isFinite(lat)||lat < -90||lat > 90||!Number.isFinite(lng)||lng < -180||lng > 180) return res.status(400).json({message:'Valid latitude and longitude are required.'})
    const { data, error } = await dbFor(req).rpc('find_nearby_hosts', { user_lat:lat, user_lng:lng, radius_meters:radius })
    if (error) throw error; res.json(data)
  } catch(e){next(e)}
})

apiRouter.post('/vouchers/purchase', requireUser, async (req,res,next)=>{
  try {
    ensure()
    const {hostId,clientMac,durationMinutes=60,speedProfile='5M/5M'}=req.body
    if(!hostId||!validMac(clientMac)) return res.status(400).json({message:'A valid host and client MAC address are required.'})
    const minutes=Number(durationMinutes)
    if(!Number.isInteger(minutes)||minutes<15||minutes>1440)return res.status(400).json({message:'Voucher duration must be between 15 minutes and 24 hours.'})
    if(!adminConfigured)throw Object.assign(new Error('SUPABASE_SECRET_KEY is required for voucher purchases.'),{status:503})
    const{data:host,error:hostError}=await supabaseAdmin.from('hosts').select('*').eq('id',hostId).single()
    if(hostError)throw hostError
    if(!mockRouterEnabled){const{data:hardware,error:hardwareError}=await supabaseAdmin.from('hardware_configs').select('id').eq('host_id',hostId).eq('enabled',true).maybeSingle();if(hardwareError)throw hardwareError;if(!hardware)return res.status(409).json({message:'This host has not enabled physical router provisioning yet.'})}

    let purchasedSession
    if(host.user_id===req.user.id){
      // Mock testing commonly uses one account for both customer and host. The
      // production RPC intentionally blocks this, so use a guarded mock-only
      // purchase path with optimistic balance checks and compensating rollback.
      purchasedSession=await purchaseOwnMockHotspot({userId:req.user.id,host,clientMac,durationMinutes:minutes,speedProfile})
    }else{
      // For normal customer-to-host purchases, purchase_voucher remains one
      // atomic PostgreSQL transaction that locks and debits the real wallet.
      const{data,error}=await dbFor(req).rpc('purchase_voucher',{p_host_id:hostId,p_client_mac:clientMac||null,p_duration_minutes:minutes,p_speed_profile:speedProfile})
      if(error){
        const message=String(error.message||'')
        if(message.includes('insufficient wallet balance'))return res.status(402).json({message:'Insufficient wallet balance. Add money before buying this voucher.'})
        if(message.includes('host unavailable'))return res.status(409).json({message:'This hotspot is currently unavailable.'})
        throw error
      }
      // PostgREST versions can serialize a composite RPC result as either an
      // object or a one-item array. Normalize it before router activation.
      purchasedSession=Array.isArray(data)?data[0]:data
      if(!purchasedSession?.id)throw Object.assign(new Error('Voucher purchase completed without a session record.'),{status:502})
    }

    // Simulate physical MikroTik activation and guarantee a six-digit PIN.
    const {session,activation}=await activateRouter(purchasedSession,hostId)
    res.status(201).json({
      session,
      voucher:session,
      routerActivation:activation,
      routerLogin:{username:session.access_code,password:session.access_code},
    })
  }catch(e){
    console.error('[voucher purchase]',{code:e.code,message:e.message,details:e.details,hint:e.hint})
    if(e.status)return res.status(e.status).json({message:e.message})
    if(['42P01','42883','PGRST205'].includes(e.code))return res.status(503).json({message:'The Supabase voucher or hardware schema is incomplete. Apply the project migrations and try again.'})
    if(e.code==='42501')return res.status(503).json({message:'The voucher service does not have the required Supabase permissions.'})
    if(e.code==='PGRST116')return res.status(404).json({message:'The selected hotspot or wallet profile was not found.'})
    next(e)
  }
})
const MOCK_DATA_RATE_NGN_PER_GB = 100
// Link speed is not the same as sustained transfer. Model average traffic at
// 5% utilization so a displayed 24 Mbps link does not bill as 24 Mbps nonstop.
const MOCK_LINK_UTILIZATION = 0.05

function usageSnapshot(metadata, now = Date.now()) {
  const linkMbps = Math.max(0, Number(metadata.mock_mbps || 24))
  const usageMbps = Math.max(0, Number(metadata.usage_mbps ?? linkMbps * MOCK_LINK_UTILIZATION))
  const baseGb = Math.max(0, Number(metadata.base_gb ?? metadata.data_used_gb ?? 0))
  const connectedAt = metadata.connected_at ? new Date(metadata.connected_at).getTime() : now
  const elapsedSeconds = metadata.connected && Number.isFinite(connectedAt) ? Math.max(0, (now - connectedAt) / 1000) : 0
  // Mbps × seconds gives megabits; divide by 8,000 for decimal gigabytes.
  const dataUsedGb = baseGb + (usageMbps * elapsedSeconds) / 8000
  return {
    linkMbps,
    usageMbps,
    dataUsedGb,
    usageValueNgn: dataUsedGb * MOCK_DATA_RATE_NGN_PER_GB,
  }
}

async function getSessionForCustomer(req, sessionId) {
  const { data, error } = await dbFor(req)
    .from('vouchers_sessions')
    .select('*, hosts(business_name,user_id,address,is_online)')
    .eq('id', sessionId)
    .eq('user_id', req.user.id)
    .single()
  if (error) throw error
  return data
}

async function calculateAndPersistUsage(session) {
  if (!adminConfigured) throw Object.assign(new Error('SUPABASE_SECRET_KEY is required for mock telemetry.'), { status: 503 })
  const { data: earning, error } = await supabaseAdmin
    .from('transactions')
    .select('id,metadata')
    .eq('session_id', session.id)
    .eq('type', 'host_earning')
    .single()
  if (error) throw error

  const metadata = earning.metadata || {}
  const snapshot = usageSnapshot(metadata)
  const nextMetadata = {
    ...metadata,
    data_used_gb: Number(snapshot.dataUsedGb.toFixed(6)),
    usage_value_ngn: Number(snapshot.usageValueNgn.toFixed(2)),
    mock_mbps: snapshot.linkMbps,
    usage_mbps: snapshot.usageMbps,
    link_utilization: MOCK_LINK_UTILIZATION,
    data_rate_ngn_per_gb: MOCK_DATA_RATE_NGN_PER_GB,
  }

  const { error: updateError } = await supabaseAdmin.from('transactions').update({ metadata: nextMetadata }).eq('id', earning.id)
  if (updateError) throw updateError
  return nextMetadata
}

apiRouter.get('/vouchers/active',requireUser,async(req,res,next)=>{
  try{ensure();const{data,error}=await dbFor(req).from('vouchers_sessions').select('*, hosts(business_name,user_id,address)').eq('user_id',req.user.id).in('status',['active','used']).gt('expires_at',new Date().toISOString()).order('created_at',{ascending:false});if(error)throw error;res.json(data||[])}catch(e){next(e)}
})

apiRouter.post('/vouchers/:id/connect',requireUser,async(req,res,next)=>{
  try{
    ensure();if(!mockRouterEnabled)return res.status(501).json({message:'Mock router mode is disabled.'})
    const session=await getSessionForCustomer(req,req.params.id)
    if(new Date(session.expires_at)<=new Date())return res.status(410).json({message:'This voucher has expired.'})
    if(!session.hosts?.is_online)return res.status(409).json({message:'This hotspot is currently offline.'})
    const current=await calculateAndPersistUsage(session)
    const now=new Date().toISOString()
    const linkMbps=Number(current.mock_mbps||crypto.randomInt(18,46))
    const metadata={...current,connected:true,connected_at:now,base_gb:Number(current.data_used_gb||0),mock_mbps:linkMbps,usage_mbps:Number((linkMbps*MOCK_LINK_UTILIZATION).toFixed(3))}
    const{error:txError}=await supabaseAdmin.from('transactions').update({metadata}).eq('session_id',session.id).eq('type','host_earning');if(txError)throw txError
    const{data:connected,error}=await supabaseAdmin.from('vouchers_sessions').update({status:'used'}).eq('id',session.id).select('*, hosts(business_name,user_id,address)').single();if(error)throw error
    res.json({session:connected,connection:{connected:true,simulated:true,mbps:metadata.mock_mbps,usageMbps:metadata.usage_mbps,dataUsedGb:metadata.data_used_gb,usageValueNgn:metadata.usage_value_ngn,rateNgnPerGb:MOCK_DATA_RATE_NGN_PER_GB}})
  }catch(e){next(e)}
})

apiRouter.get('/vouchers/:id/telemetry',requireUser,async(req,res,next)=>{
  try{ensure();const session=await getSessionForCustomer(req,req.params.id);const usage=await calculateAndPersistUsage(session);res.json({connected:session.status==='used'&&Boolean(usage.connected),simulated:true,mbps:Number(usage.mock_mbps||0),usageMbps:Number(usage.usage_mbps||0),dataUsedGb:Number(usage.data_used_gb||0),usageValueNgn:Number(usage.usage_value_ngn||0),rateNgnPerGb:MOCK_DATA_RATE_NGN_PER_GB})}catch(e){next(e)}
})

apiRouter.post('/vouchers/:id/disconnect',requireUser,async(req,res,next)=>{
  try{ensure();const session=await getSessionForCustomer(req,req.params.id);const usage=await calculateAndPersistUsage(session);const metadata={...usage,connected:false,base_gb:Number(usage.data_used_gb||0),disconnected_at:new Date().toISOString()};const{error:txError}=await supabaseAdmin.from('transactions').update({metadata}).eq('session_id',session.id).eq('type','host_earning');if(txError)throw txError;const{data,error}=await supabaseAdmin.from('vouchers_sessions').update({status:'active'}).eq('id',session.id).select('*, hosts(business_name,user_id,address)').single();if(error)throw error;res.json({session:data,connection:{connected:false,simulated:true,mbps:0,dataUsedGb:metadata.data_used_gb,usageValueNgn:metadata.usage_value_ngn,rateNgnPerGb:MOCK_DATA_RATE_NGN_PER_GB}})}catch(e){next(e)}
})

apiRouter.get('/hosts/analytics',requireUser,async(req,res,next)=>{
  try{
    ensure();if(!adminConfigured)throw Object.assign(new Error('SUPABASE_SECRET_KEY is required for host analytics.'),{status:503})
    const{data:host,error:hostError}=await dbFor(req).from('hosts').select('*').eq('user_id',req.user.id).single();if(hostError)throw hostError
    const{data:earnings,error}=await supabaseAdmin.from('transactions').select('amount,metadata,session_id').eq('host_id',host.id).eq('type','host_earning');if(error)throw error
    const rows=(earnings||[]).map(row=>{
      const metadata=row.metadata||{}
      const snapshot=usageSnapshot(metadata)
      return{...row,dynamicGb:snapshot.dataUsedGb,usageValue:snapshot.usageValueNgn}
    })
    const totalDataGb=rows.reduce((sum,row)=>sum+row.dynamicGb,0)
    const pendingUsageValue=rows.reduce((sum,row)=>sum+row.usageValue,0)
    const liveMbps=rows.filter(row=>row.metadata?.connected).reduce((sum,row)=>sum+Number(row.metadata?.mock_mbps||0),0)
    const activeConnections=rows.filter(row=>row.metadata?.connected).length
    const voucherRevenue=Number(host.total_earnings||0)
    const{data:recentSessions}=await supabaseAdmin.from('vouchers_sessions').select('id,user_id,access_code,amount_paid,status,starts_at,expires_at,created_at').eq('host_id',host.id).order('created_at',{ascending:false}).limit(5)
    res.json({hostId:host.id,voucherRevenue,totalDataGb:Number(totalDataGb.toFixed(4)),liveMbps,activeConnections,rateNgnPerGb:MOCK_DATA_RATE_NGN_PER_GB,pendingBalance:Number(pendingUsageValue.toFixed(2)),totalAccumulatedEarnings:Number((voucherRevenue+pendingUsageValue).toFixed(2)),recentSessions:recentSessions||[]})
  }catch(e){next(e)}
})

async function validateChatParticipant(userId,{hostId,sessionId,receiverId}){
  if(!adminConfigured)throw Object.assign(new Error('SUPABASE_SECRET_KEY is required for chat.'),{status:503})
  if(!hostId||!sessionId)throw Object.assign(new Error('A hotspot and voucher session are required for chat.'),{status:400})
  const{data:session,error}=await supabaseAdmin.from('vouchers_sessions').select('id,user_id,host_id,status,hosts!inner(user_id,business_name)').eq('id',sessionId).eq('host_id',hostId).single()
  if(error)throw error
  const hostOwnerId=session.hosts.user_id
  if(userId!==session.user_id&&userId!==hostOwnerId)throw Object.assign(new Error('You are not a participant in this conversation.'),{status:403})
  const expectedReceiver=userId===hostOwnerId?session.user_id:hostOwnerId
  if(receiverId&&receiverId!==expectedReceiver)throw Object.assign(new Error('Invalid message recipient.'),{status:400})
  return{session,hostOwnerId,receiverId:expectedReceiver}
}

async function hydrateChatMessages(rows){
  return Promise.all((rows||[]).map(async row=>{
    if(!row.attachment_path)return row
    const{data}=await supabaseAdmin.storage.from(CHAT_BUCKET).createSignedUrl(row.attachment_path,3600)
    return{...row,attachment_url:data?.signedUrl||null}
  }))
}

function handleChatError(error,res,next){
  console.error('[chat]',{code:error.code,message:error.message,details:error.details})
  if(error.status)return res.status(error.status).json({message:error.message})
  if(['42703','42P01','23514','PGRST204'].includes(error.code))return res.status(503).json({message:'The chat database migration is not installed. Apply migration 003_chat_engine.sql in Supabase.'})
  return next(error)
}

apiRouter.get('/messages',requireUser,async(req,res,next)=>{
  try{ensure();const{hostId,sessionId}=req.query;await validateChatParticipant(req.user.id,{hostId,sessionId});const{data,error}=await supabaseAdmin.from('messages').select('*').eq('host_id',hostId).eq('session_id',sessionId).order('timestamp');if(error)throw error;res.json(await hydrateChatMessages(data))}catch(e){handleChatError(e,res,next)}
})
apiRouter.get('/messages/inbox',requireUser,async(req,res,next)=>{
  try{ensure();if(!adminConfigured)throw Object.assign(new Error('SUPABASE_SECRET_KEY is required for chat.'),{status:503});const{data:host,error:hErr}=await supabaseAdmin.from('hosts').select('id').eq('user_id',req.user.id).single();if(hErr)throw hErr;const{data,error}=await supabaseAdmin.from('messages').select('*, vouchers_sessions(user_id)').eq('host_id',host.id).order('timestamp',{ascending:false});if(error)throw error;res.json(await hydrateChatMessages(data))}catch(e){handleChatError(e,res,next)}
})
apiRouter.post('/messages/upload',requireUser,chatUpload.single('file'),async(req,res,next)=>{
  try{
    ensure();if(!req.file)return res.status(400).json({message:'Choose a file to upload.'})
    const{hostId,sessionId,receiverId}=req.body;await validateChatParticipant(req.user.id,{hostId,sessionId,receiverId})
    const{error:bucketError}=await supabaseAdmin.storage.getBucket(CHAT_BUCKET)
    if(bucketError){const{error:createError}=await supabaseAdmin.storage.createBucket(CHAT_BUCKET,{public:false,fileSizeLimit:12*1024*1024});if(createError&&!String(createError.message).includes('already exists'))throw createError}
    const safeName=req.file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_').slice(-120)||'attachment'
    const path=`${hostId}/${sessionId}/${crypto.randomUUID()}-${safeName}`
    const{error}=await supabaseAdmin.storage.from(CHAT_BUCKET).upload(path,req.file.buffer,{contentType:req.file.mimetype,upsert:false});if(error)throw error
    const kind=req.file.mimetype.startsWith('image/')?'image':req.file.mimetype.startsWith('audio/')?'audio':req.file.mimetype.startsWith('video/')?'video':'file'
    res.status(201).json({path,name:req.file.originalname,mime:req.file.mimetype,size:req.file.size,kind})
  }catch(e){handleChatError(e,res,next)}
})
apiRouter.post('/messages',requireUser,async(req,res,next)=>{
  try{
    ensure();const{text='',receiverId,hostId,sessionId,attachment,authorRole}=req.body;const cleanText=String(text).trim()
    if(cleanText.length>2000)return res.status(400).json({message:'Messages cannot exceed 2,000 characters.'})
    if(!cleanText&&!attachment?.path)return res.status(400).json({message:'Type a message or attach a file.'})
    const conversation=await validateChatParticipant(req.user.id,{hostId,sessionId,receiverId})
    const messageType=attachment?.kind||'text'
    const resolvedRole=req.user.id===conversation.hostOwnerId&&req.user.id!==conversation.session.user_id?'host':req.user.id===conversation.session.user_id&&req.user.id!==conversation.hostOwnerId?'customer':authorRole==='host'?'host':'customer'
    const{data,error}=await supabaseAdmin.from('messages').insert({sender_id:req.user.id,receiver_id:conversation.receiverId,host_id:hostId,session_id:sessionId,text:cleanText||null,message_type:messageType,author_role:resolvedRole,attachment_path:attachment?.path||null,attachment_name:attachment?.name||null,attachment_mime:attachment?.mime||null,attachment_size:attachment?.size||null}).select().single();if(error)throw error
    res.status(201).json((await hydrateChatMessages([data]))[0])
  }catch(e){handleChatError(e,res,next)}
})
apiRouter.patch('/messages/read',requireUser,async(req,res,next)=>{
  try{ensure();const{hostId,sessionId}=req.body;await validateChatParticipant(req.user.id,{hostId,sessionId});const{error}=await supabaseAdmin.from('messages').update({read_at:new Date().toISOString()}).eq('host_id',hostId).eq('session_id',sessionId).eq('receiver_id',req.user.id).is('read_at',null);if(error)throw error;res.sendStatus(204)}catch(e){handleChatError(e,res,next)}
})

apiRouter.post('/tickets',requireUser,async(req,res,next)=>{
  try{ensure();const{hostId,subject,issueDescription}=req.body;const{data,error}=await dbFor(req).from('tickets').insert({user_id:req.user.id,host_id:hostId||null,subject,issue_description:issueDescription}).select().single();if(error)throw error;res.status(201).json(data)}catch(e){next(e)}
})
apiRouter.get('/tickets',requireUser,async(req,res,next)=>{
  try{ensure();const{data,error}=await dbFor(req).from('tickets').select('*, hosts(business_name)').order('created_at',{ascending:false});if(error)throw error;res.json(data)}catch(e){next(e)}
})

// Admin endpoints use both authenticated admin identity and a separately rotated API key.
apiRouter.get('/admin/tickets',requireUser,requireAdmin,async(req,res,next)=>{
  try{ensure();const{data:profile}=await supabaseAdmin.from('users').select('role').eq('id',req.user.id).single();if(profile?.role!=='admin')return res.status(403).json({message:'Admin role required.'});const{data,error}=await supabaseAdmin.from('tickets').select('*, users(name,phone), hosts(business_name)').order('created_at');if(error)throw error;res.json(data)}catch(e){next(e)}
})
apiRouter.patch('/admin/tickets/:id',requireUser,requireAdmin,async(req,res,next)=>{
  try{ensure();const{data:profile}=await supabaseAdmin.from('users').select('role').eq('id',req.user.id).single();if(profile?.role!=='admin')return res.status(403).json({message:'Admin role required.'});const{status,adminNotes}=req.body;const update={status,admin_notes:adminNotes,assigned_to:req.user.id};if(status==='resolved')update.resolved_at=new Date().toISOString();const{data,error}=await supabaseAdmin.from('tickets').update(update).eq('id',req.params.id).select().single();if(error)throw error;res.json(data)}catch(e){next(e)}
})
apiRouter.post('/admin/wallet-adjustment',requireUser,requireAdmin,async(req,res,next)=>{
  try{ensure();const amount=Number(req.body.amount);if(!req.body.userId||!Number.isFinite(amount)||amount===0)return res.status(400).json({message:'Valid user and non-zero amount required.'});const client=dbFor(req);const{data:balance,error}=await client.rpc('admin_adjust_wallet',{p_user_id:req.body.userId,p_amount:amount,p_reason:req.body.reason});if(error)throw error;res.json({balance})}catch(e){next(e)}
})
apiRouter.post('/admin/sessions/:id/reset',requireUser,requireAdmin,async(req,res,next)=>{
  try{ensure();const{data:profile}=await supabaseAdmin.from('users').select('role').eq('id',req.user.id).single();if(profile?.role!=='admin')return res.status(403).json({message:'Admin role required.'});const accessCode=crypto.randomBytes(6).toString('hex').toUpperCase();const{data,error}=await supabaseAdmin.from('vouchers_sessions').update({access_code:accessCode,status:'active',starts_at:new Date().toISOString(),expires_at:new Date(Date.now()+60*60*1000).toISOString()}).eq('id',req.params.id).select().single();if(error)throw error;res.json(data)}catch(e){next(e)}
})
