import express from 'express'
import crypto from 'node:crypto'
import multer from 'multer'
import { requireAdmin, requireUser } from './auth.js'
import { adminConfigured, configured, supabaseAdmin, userClient } from './supabase.js'

export const apiRouter = express.Router()
const ensure = () => { if (!configured) throw Object.assign(new Error('Supabase is not configured. Copy .env.example to .env.'), { status: 503 }) }
const dbFor = (req) => req.accessToken ? userClient(req.accessToken) : supabaseAdmin
const validMac = (value) => !value || /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(value)
const mockRouterEnabled = process.env.MOCK_ROUTER_ENABLED !== 'false'
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

async function activateMockRouter(session) {
  if (!mockRouterEnabled) throw Object.assign(new Error('Physical router activation is not configured yet.'), { status: 501 })
  const activatedSession = await assignMockVoucherPin(session.id)
  return {
    session: activatedSession,
    activation: {
      success: true,
      simulated: true,
      provider: 'mock-mikrotik',
      activatedAt: new Date().toISOString(),
      message: 'Mock router activated successfully.',
    },
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
    res.json({'control:Auth-Type':{'type':'string','value':['Accept']},'reply:Mikrotik-Rate-Limit':{'type':'string','value':[session.speed_limit_profile]},'reply:Session-Timeout':{'type':'integer','value':[seconds]},'control:Simultaneous-Use':{'type':'integer','value':[1]}})
  }catch(e){next(e)}
})

apiRouter.get('/me', requireUser, async (req, res, next) => {
  try { ensure(); const { data, error } = await dbFor(req).from('users').select('*').eq('id', req.user.id).single(); if (error) throw error; res.json(data) } catch (e) { next(e) }
})
apiRouter.get('/transactions', requireUser, async (req, res, next) => {
  try { ensure(); const { data, error } = await dbFor(req).from('transactions').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(50); if (error) throw error; res.json(data) } catch (e) { next(e) }
})

apiRouter.get('/hosts/mine', requireUser, async (req,res,next)=>{
  try{ensure();const{data,error}=await dbFor(req).from('hosts').select('*').eq('user_id',req.user.id).maybeSingle();if(error)throw error;res.json(data)}catch(e){next(e)}
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
    if(!mockRouterEnabled) return res.status(501).json({message:'Physical router activation is not configured yet.'})

    const minutes=Number(durationMinutes)
    if(!Number.isInteger(minutes)||minutes<15||minutes>1440)return res.status(400).json({message:'Voucher duration must be between 15 minutes and 24 hours.'})
    if(!adminConfigured)throw Object.assign(new Error('SUPABASE_SECRET_KEY is required for voucher purchases.'),{status:503})
    const{data:host,error:hostError}=await supabaseAdmin.from('hosts').select('*').eq('id',hostId).single()
    if(hostError)throw hostError

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
    const {session,activation}=await activateMockRouter(purchasedSession)
    res.status(201).json({
      session,
      voucher:session,
      routerActivation:activation,
      routerLogin:{username:session.access_code,password:session.access_code},
    })
  }catch(e){
    console.error('[voucher purchase]',{code:e.code,message:e.message,details:e.details,hint:e.hint})
    if(e.status)return res.status(e.status).json({message:e.message})
    if(['42P01','42883'].includes(e.code))return res.status(503).json({message:'The Supabase voucher schema is incomplete. Apply the project migrations and try again.'})
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
