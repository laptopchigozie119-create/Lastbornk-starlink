// Run this small controller on a machine that can reach the MikroTik LAN.
// Put it behind HTTPS (Caddy/Cloudflare Tunnel/Tailscale Funnel) and configure
// that public /vouchers URL in Lastbornk's Host Dashboard.
import http from 'node:http'
import crypto from 'node:crypto'

const port=Number(process.env.PORT||8787)
const secret=process.env.LASTBORNK_CONTROLLER_SECRET
const routerUrl=process.env.MIKROTIK_REST_URL // e.g. https://192.168.88.1/rest
const routerUser=process.env.MIKROTIK_USER
const routerPassword=process.env.MIKROTIK_PASSWORD
if(!secret||!routerUrl||!routerUser||!routerPassword)throw new Error('Set controller and MikroTik environment variables.')

const timingSafe=(a,b)=>{const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb)}
const server=http.createServer(async(req,res)=>{
 if(req.method!=='POST'||req.url!=='/vouchers'){res.writeHead(404).end('Not found');return}
 const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks)
 const expected=crypto.createHmac('sha256',secret).update(raw).digest('hex')
 if(!timingSafe(String(req.headers['x-lastbornk-signature']||''),expected)){res.writeHead(401).end('Invalid signature');return}
 try{
  const event=JSON.parse(raw)
  if(event.event!=='voucher.activate')throw new Error('Unsupported event')
  const seconds=Math.max(60,Math.floor((new Date(event.expiresAt)-Date.now())/1000))
  const response=await fetch(`${routerUrl.replace(/\/$/,'')}/ip/hotspot/user`,{
   method:'PUT',headers:{authorization:`Basic ${Buffer.from(`${routerUser}:${routerPassword}`).toString('base64')}`,'content-type':'application/json'},
   body:JSON.stringify({name:event.pin,password:event.pin,profile:process.env.MIKROTIK_HOTSPOT_PROFILE||'lastbornk-default','limit-uptime':`${seconds}s`,'mac-address':event.clientMac||'00:00:00:00:00:00',comment:`Lastbornk ${event.sessionId}`})
  })
  if(!response.ok)throw new Error(`MikroTik REST returned ${response.status}: ${await response.text()}`)
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,sessionId:event.sessionId}))
 }catch(error){console.error(error);res.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({ok:false,message:error.message}))}
})
server.listen(port,()=>console.log(`Lastbornk MikroTik controller listening on :${port}`))
