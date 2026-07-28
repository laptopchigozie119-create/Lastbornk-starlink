import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir=path.dirname(fileURLToPath(import.meta.url))
const config=JSON.parse(await fs.readFile(path.join(dir,'config.json'),'utf8'))
if(config.appUrl.includes('YOUR-VERCEL'))throw new Error('Edit local-captive/config.json and set your deployed Vercel appUrl first.')
const html=await fs.readFile(path.join(dir,'portal.html'),'utf8')
const readBody=async req=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);return Buffer.concat(chunks)}
const relay=async(res,url,options)=>{try{const response=await fetch(url,options),body=Buffer.from(await response.arrayBuffer());res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'application/json','cache-control':'no-store'});res.end(body)}catch(error){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({message:error.message}))}}
const server=http.createServer(async(req,res)=>{
  if(req.method==='POST'&&req.url==='/auth/otp'){return relay(res,`${config.supabaseUrl}/auth/v1/otp`,{method:'POST',headers:{apikey:config.supabasePublishableKey,'content-type':'application/json'},body:await readBody(req)})}
  if(req.method==='POST'&&req.url==='/auth/verify'){return relay(res,`${config.supabaseUrl}/auth/v1/verify`,{method:'POST',headers:{apikey:config.supabasePublishableKey,'content-type':'application/json'},body:await readBody(req)})}
  if(req.method==='POST'&&req.url==='/claim'){return relay(res,`${config.appUrl.replace(/\/$/,'')}/api/captive/claim`,{method:'POST',headers:{authorization:String(req.headers.authorization||''),'content-type':'application/json'},body:await readBody(req)})}
  if(['/generate_204','/gen_204','/hotspot-detect.html','/ncsi.txt','/connecttest.txt','/redirect'].some(p=>req.url.startsWith(p))){res.writeHead(302,{location:'/'});res.end();return}
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(html)
})
const port=Number(process.env.PORT||config.port||8787)
server.listen(port,'0.0.0.0',()=>{
  const addresses=[]
  for(const list of Object.values(os.networkInterfaces()))for(const item of list||[])if(item.family==='IPv4'&&!item.internal)addresses.push(`http://${item.address}:${port}`)
  console.log('\nLastbornk local captive portal is ready.')
  console.log('Open one of these addresses on the phone connected to Windows Mobile Hotspot:')
  console.log(addresses.map(a=>`  ${a}`).join('\n')||`  http://192.168.137.1:${port}`)
  console.log('\nPress Ctrl+C to stop.\n')
})
