import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check, FileText, Headphones, Image, Inbox, Loader2, MessageCircle, Mic, Paperclip, Send, Square, TicketCheck, Wallet, X } from 'lucide-react'
import { secureApi, supabase } from '../lib/supabase'

function Shell({ children, close, wide=false }) {
  return <div className="modal-backdrop" onMouseDown={e=>e.target===e.currentTarget&&close()}><div className={`modal feature-modal ${wide?'booking-modal':''}`}><button className="modal-close" onClick={close}><X/></button>{children}</div></div>
}

export function ProductionTopUp({ close }) {
  const [amount,setAmount]=useState(5000), [busy,setBusy]=useState(false), [error,setError]=useState('')
  const pay=async()=>{setBusy(true);setError('');try{const result=await secureApi('/api/payments/initialize',{method:'POST',body:JSON.stringify({amount})});window.location.assign(result.authorizationUrl)}catch(e){setError(e.message);setBusy(false)}}
  return <Shell close={close}><div className="modal-icon"><Wallet/></div><h2>Add money securely</h2><p>Pay by card, bank transfer or USSD through Paystack.</p><div className="amount-input"><span>₦</span><input type="number" min="100" max="1000000" value={amount} onChange={e=>setAmount(Number(e.target.value))}/></div><div className="quick-amounts">{[1000,2000,5000,10000].map(n=><button key={n} className={amount===n?'active':''} onClick={()=>setAmount(n)}>₦{n.toLocaleString()}</button>)}</div>{error&&<p className="form-error">{error}</p>}<button className="primary wide" disabled={busy} onClick={pay}>{busy?<Loader2 className="spin"/>:`Continue to Paystack`}</button></Shell>
}

function MessageContent({ message }) {
  return <>
    {message.text&&<span className="message-text">{message.text}</span>}
    {message.message_type==='image'&&message.attachment_url&&<a href={message.attachment_url} target="_blank" rel="noreferrer"><img className="chat-image" src={message.attachment_url} alt={message.attachment_name||'Shared image'}/></a>}
    {message.message_type==='audio'&&message.attachment_url&&<audio className="chat-audio" controls preload="metadata" src={message.attachment_url}/>}
    {message.message_type==='video'&&message.attachment_url&&<video className="chat-video" controls preload="metadata" src={message.attachment_url}/>}
    {message.message_type==='file'&&message.attachment_url&&<a className="chat-file" href={message.attachment_url} target="_blank" rel="noreferrer"><FileText/><span><b>{message.attachment_name||'Download file'}</b><small>{message.attachment_size?`${(message.attachment_size/1024/1024).toFixed(2)} MB`:message.attachment_mime}</small></span></a>}
  </>
}

function ChatComposer({ hostId, sessionId, receiverId, authorRole, onSent }) {
  const [text,setText]=useState(''),[attachment,setAttachment]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[recording,setRecording]=useState(false)
  const inputRef=useRef(null),recorderRef=useRef(null),chunksRef=useRef([])
  const upload=async file=>{setBusy(true);setError('');try{const body=new FormData();body.append('file',file);body.append('hostId',hostId);body.append('sessionId',sessionId);body.append('receiverId',receiverId);const data=await secureApi('/api/messages/upload',{method:'POST',body});setAttachment(data)}catch(e){setError(e.message)}finally{setBusy(false)}}
  const toggleRecording=async()=>{if(recording){recorderRef.current?.stop();return}try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});const recorder=new MediaRecorder(stream);chunksRef.current=[];recorder.ondataavailable=e=>{if(e.data.size)chunksRef.current.push(e.data)};recorder.onstop=async()=>{stream.getTracks().forEach(track=>track.stop());setRecording(false);const blob=new Blob(chunksRef.current,{type:recorder.mimeType||'audio/webm'});await upload(new File([blob],`voice-note-${Date.now()}.webm`,{type:blob.type}))};recorderRef.current=recorder;recorder.start();setRecording(true)}catch(e){setError('Microphone access was denied or is unavailable.')}}
  const send=async e=>{e.preventDefault();if(!text.trim()&&!attachment)return;setBusy(true);setError('');try{const row=await secureApi('/api/messages',{method:'POST',body:JSON.stringify({text,attachment,hostId,sessionId,receiverId,authorRole})});setText('');setAttachment(null);onSent(row)}catch(e){setError(e.message)}finally{setBusy(false)}}
  return <div className="composer-wrap">{attachment&&<div className="attachment-chip">{attachment.kind==='image'?<Image/>:<FileText/>}<span>{attachment.name}</span><button onClick={()=>setAttachment(null)}><X/></button></div>}{error&&<p className="form-error">{error}</p>}<form className="chat-compose rich" onSubmit={send}><input value={text} maxLength={2000} onChange={e=>setText(e.target.value)} placeholder={recording?'Recording voice note…':'Type a message…'}/><input ref={inputRef} hidden type="file" accept="image/*,audio/*,video/mp4,video/webm,.pdf,.zip,.doc,.docx,.txt" onChange={e=>e.target.files?.[0]&&upload(e.target.files[0])}/><button type="button" className="compose-tool" title="Attach file" onClick={()=>inputRef.current?.click()}><Paperclip/></button><button type="button" className={`compose-tool ${recording?'recording':''}`} title="Voice note" onClick={toggleRecording}>{recording?<Square/>:<Mic/>}</button><button className="send-button" disabled={busy||(!text.trim()&&!attachment)}>{busy?<Loader2 className="spin"/>:<Send/>}</button></form></div>
}

function isSentByViewer(message, currentUserId, viewerRole) {
  // author_role records the interface that actually created the message and is
  // authoritative in both normal and same-account mock conversations. Older
  // rows without that field fall back to the authenticated sender UUID.
  if (message.author_role === 'customer' || message.author_role === 'host') {
    return message.author_role === viewerRole
  }
  return message.sender_id === currentUserId
}

function Bubble({ message, currentUserId, viewerRole }) {
  const mine = isSentByViewer(message, currentUserId, viewerRole)
  return <div className={`chat-bubble ${mine?'mine outgoing':'incoming'}`} data-direction={mine?'outgoing':'incoming'}><MessageContent message={message}/><small>{new Date(message.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</small></div>
}

export function MessageHostModal({ session, currentUserId, close }) {
  const [messages,setMessages]=useState([]),[error,setError]=useState('')
  const hostId=session.host_id||session.hostId,sessionId=session.id,receiverId=session.hosts?.user_id||session.hostOwnerId||currentUserId
  const load=()=>secureApi(`/api/messages?hostId=${hostId}&sessionId=${sessionId}`).then(setMessages).catch(e=>setError(e.message))
  useEffect(()=>{let channel;load();secureApi('/api/messages/read',{method:'PATCH',body:JSON.stringify({hostId,sessionId})}).catch(()=>{});if(supabase)channel=supabase.channel(`customer-chat:${sessionId}`).on('postgres_changes',{event:'INSERT',schema:'public',table:'messages',filter:`session_id=eq.${sessionId}`},load).subscribe();return()=>{if(channel)supabase.removeChannel(channel)}},[hostId,sessionId])
  const add=row=>setMessages(old=>old.some(m=>m.id===row.id)?old:[...old,row])
  return <Shell close={close} wide><p className="eyebrow">ACTIVE HOTSPOT</p><h2><MessageCircle size={21}/> Message Host</h2><p>{session.hosts?.business_name||session.hostName}</p><div className="chat-feed">{messages.map(m=><Bubble key={m.id} message={m} currentUserId={currentUserId} viewerRole="customer"/>)}{!messages.length&&!error&&<div className="chat-empty">Ask the host about power, signal, or connection issues.</div>}</div>{error&&<p className="form-error">{error}</p>}<ChatComposer hostId={hostId} sessionId={sessionId} receiverId={receiverId} authorRole="customer" onSent={add}/></Shell>
}

export function HostInbox({ currentUserId }) {
  const [messages,setMessages]=useState([]),[selected,setSelected]=useState(null),[error,setError]=useState('')
  const load=()=>secureApi('/api/messages/inbox').then(setMessages).catch(e=>setError(e.message))
  useEffect(()=>{let channel;load();if(supabase)channel=supabase.channel('host-inbox').on('postgres_changes',{event:'INSERT',schema:'public',table:'messages'},load).subscribe();return()=>{if(channel)supabase.removeChannel(channel)}},[])
  const rooms=useMemo(()=>{const map=new Map();messages.forEach(m=>{const guest=m.vouchers_sessions?.user_id||(m.sender_id===currentUserId?m.receiver_id:m.sender_id);const key=`${m.session_id}:${guest}`;if(!map.has(key))map.set(key,{key,guest,sessionId:m.session_id,hostId:m.host_id,last:m,unread:0});if(m.receiver_id===currentUserId&&!m.read_at)map.get(key).unread++});return[...map.values()]},[messages,currentUserId])
  const room=rooms.find(r=>r.key===selected),roomMessages=room?messages.filter(m=>m.session_id===room.sessionId).sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp)):[]
  const choose=async key=>{setSelected(key);const chosen=rooms.find(r=>r.key===key);if(chosen)secureApi('/api/messages/read',{method:'PATCH',body:JSON.stringify({hostId:chosen.hostId,sessionId:chosen.sessionId})}).then(load).catch(()=>{})}
  const add=row=>setMessages(old=>[row,...old.filter(m=>m.id!==row.id)])
  return <div className="inbox-layout"><aside><h3><Inbox/> Inbox</h3>{rooms.map(r=><button key={r.key} className={selected===r.key?'active':''} onClick={()=>choose(r.key)}><span className="avatar">{r.guest.slice(0,2).toUpperCase()}</span><span><b>Customer · {r.last.attachment_name?'Attachment':'Message'}</b><small>{r.last.text||r.last.attachment_name||'Media message'}</small></span>{r.unread>0&&<i>{r.unread}</i>}</button>)}{!rooms.length&&!error&&<div className="chat-empty">No customer messages yet.</div>}</aside><section>{error&&<p className="form-error">{error}</p>}{room?<><div className="chat-feed">{roomMessages.map(m=><Bubble key={m.id} message={m} currentUserId={currentUserId} viewerRole="host"/>)}</div><ChatComposer hostId={room.hostId} sessionId={room.sessionId} receiverId={room.guest} authorRole="host" onSent={add}/></>:<div className="chat-empty"><MessageCircle/><p>Select a customer conversation</p></div>}</section></div>
}

export function SupportModal({ activeSession, close }) {
  const [subject,setSubject]=useState('Cannot Authenticate with Router'),[description,setDescription]=useState(''),[busy,setBusy]=useState(false),[done,setDone]=useState(null),[error,setError]=useState('')
  const submit=async(e)=>{e.preventDefault();setBusy(true);setError('');try{const ticket=await secureApi('/api/tickets',{method:'POST',body:JSON.stringify({hostId:activeSession?.host_id,subject,issueDescription:description})});setDone(ticket)}catch(e){setError(e.message)}finally{setBusy(false)}}
  return <Shell close={close}>{done?<><div className="success-ring"><Check/></div><h2>Ticket received</h2><p>Reference: {done.id}. Customer care will review it shortly.</p><button className="primary wide" onClick={close}>Done</button></>:<form onSubmit={submit}><div className="modal-icon"><Headphones/></div><h2>Customer care</h2><p>Tell us what happened. Your active hotspot is attached automatically.</p><label className="field-label">Issue</label><select className="support-select" value={subject} onChange={e=>setSubject(e.target.value)}>{['Payment Failed but Debited','Cannot Authenticate with Router','Hardware Offline','Slow or Unstable Connection','Other'].map(x=><option key={x}>{x}</option>)}</select><label className="field-label">Description</label><textarea className="support-textarea" minLength={10} maxLength={4000} required value={description} onChange={e=>setDescription(e.target.value)} placeholder="Include what you tried and when it happened."/>{error&&<p className="form-error">{error}</p>}<button className="primary wide" disabled={busy}>{busy?<Loader2 className="spin"/>:'Submit support ticket'}</button></form>}</Shell>
}

export function AdminTicketDashboard() {
  const [tickets,setTickets]=useState([]),[key,setKey]=useState('')
  const load=()=>secureApi('/api/admin/tickets',{headers:{'x-admin-key':key}}).then(setTickets)
  const resolve=async id=>{await secureApi(`/api/admin/tickets/${id}`,{method:'PATCH',headers:{'x-admin-key':key},body:JSON.stringify({status:'resolved',adminNotes:'Resolved by platform support'})});load()}
  return <div><div className="page-heading"><p className="eyebrow">PLATFORM OPERATIONS</p><h1>Customer care center</h1></div><div className="admin-key"><input type="password" placeholder="Admin API key" value={key} onChange={e=>setKey(e.target.value)}/><button className="primary" onClick={load}>Load tickets</button></div><div className="booking-list">{tickets.map(t=><div className="booking-row" key={t.id}><span className="booking-icon"><TicketCheck/></span><div><h3>{t.subject}</h3><p>{t.users?.name} · {t.issue_description}</p><small className={`status ${t.status}`}>{t.status}</small></div>{t.status!=='resolved'&&<button className="secondary" onClick={()=>resolve(t.id)}>Resolve</button>}</div>)}</div></div>
}
