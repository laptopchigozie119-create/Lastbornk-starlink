import express from 'express'
import crypto from 'node:crypto'
import { requireAdmin, requireUser } from './auth.js'
import { configured, supabaseAdmin, userClient } from './supabase.js'

export const apiRouter = express.Router()
const ensure = () => { if (!configured) throw Object.assign(new Error('Supabase is not configured. Copy .env.example to .env.'), { status: 503 }) }
const dbFor = (req) => req.accessToken ? userClient(req.accessToken) : supabaseAdmin
const validMac = (value) => !value || /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(value)

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
    ensure(); const {hostId,clientMac,durationMinutes=60,speedProfile='5M/5M'}=req.body
    if(!hostId||!validMac(clientMac)) return res.status(400).json({message:'A valid host and client MAC address are required.'})
    const {data,error}=await dbFor(req).rpc('purchase_voucher',{p_host_id:hostId,p_client_mac:clientMac||null,p_duration_minutes:Number(durationMinutes),p_speed_profile:speedProfile})
    if(error) throw error
    res.status(201).json({session:data,routerLogin:{username:data.access_code,password:data.access_code}})
  }catch(e){next(e)}
})
apiRouter.get('/vouchers/active',requireUser,async(req,res,next)=>{
  try{ensure();const{data,error}=await dbFor(req).from('vouchers_sessions').select('*, hosts(business_name,user_id,address)').eq('user_id',req.user.id).eq('status','active').gt('expires_at',new Date().toISOString()).order('created_at',{ascending:false});if(error)throw error;res.json(data)}catch(e){next(e)}
})

apiRouter.get('/messages',requireUser,async(req,res,next)=>{
  try{ensure();const hostId=req.query.hostId;if(!hostId)return res.status(400).json({message:'hostId is required'});const{data,error}=await dbFor(req).from('messages').select('*').eq('host_id',hostId).or(`sender_id.eq.${req.user.id},receiver_id.eq.${req.user.id}`).order('timestamp');if(error)throw error;res.json(data)}catch(e){next(e)}
})
apiRouter.get('/messages/inbox',requireUser,async(req,res,next)=>{
  try{ensure();const{data:host,error:hErr}=await dbFor(req).from('hosts').select('id').eq('user_id',req.user.id).single();if(hErr)throw hErr;const{data,error}=await dbFor(req).from('messages').select('*').eq('host_id',host.id).order('timestamp',{ascending:false});if(error)throw error;res.json(data)}catch(e){next(e)}
})
apiRouter.post('/messages',requireUser,async(req,res,next)=>{
  try{ensure();const{text,receiverId,hostId,sessionId}=req.body;if(!text?.trim()||text.length>2000)return res.status(400).json({message:'Message must be 1–2,000 characters.'});const{data,error}=await dbFor(req).from('messages').insert({sender_id:req.user.id,receiver_id:receiverId,host_id:hostId,session_id:sessionId||null,text:text.trim()}).select().single();if(error)throw error;res.status(201).json(data)}catch(e){next(e)}
})
apiRouter.patch('/messages/read',requireUser,async(req,res,next)=>{
  try{ensure();const{error}=await dbFor(req).from('messages').update({read_at:new Date().toISOString()}).eq('host_id',req.body.hostId).eq('receiver_id',req.user.id).is('read_at',null);if(error)throw error;res.sendStatus(204)}catch(e){next(e)}
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
