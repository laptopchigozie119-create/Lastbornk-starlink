import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity, ArrowDownLeft, ArrowRight, ArrowUpRight, BadgeCheck, Bell, Check,
  ChevronDown, ChevronRight, CircleHelp, Clock3, CreditCard, Gauge, Home, Loader2,
  LocateFixed, LogOut, MapPin, Menu, MessageCircle, Navigation, Plus, Radio, Search, Settings,
  ShieldCheck, SlidersHorizontal, Star, Store, UserRound, Users, Wallet, Wifi, X, Zap
} from 'lucide-react'
import './styles.css'
import './network-features.css'
import { HostInbox, MessageHostModal, ProductionTopUp, SupportModal } from './components/NetworkFeatures'
import { secureApi, supabase } from './lib/supabase'
import { getCurrentPosition } from './lib/location'
import { submitRouterLogin } from './lib/captive'

const EMPTY_DASHBOARD = {
  user: { id: '', name: 'Lastbornk user', balance: 0, wallet_balance: 0 },
  nearby: [],
  bookings: [],
  transactions: [],
}
const money = (n) => `₦${Number(n || 0).toLocaleString('en-NG')}`
const formatDate = (date) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(date))
const api = async (url, options) => {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  if (!res.ok) throw new Error(data?.message || `Request failed (${res.status})`)
  return data
}

function Logo({ compact = false }) {
  return <div className="logo"><span className="logo-mark"><Wifi size={20}/></span>{!compact && <span>lastborn<span>k</span></span>}</div>
}

function App() {
  const [page, setPage] = useState('home')
  const [dashboard, setDashboard] = useState(EMPTY_DASHBOARD)
  const [hosts, setHosts] = useState([])
  const [bookings, setBookings] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(null)
  const [toast, setToast] = useState(null)
  const [role, setRole] = useState('customer')

  const load = async () => {
    setLoading(true)
    try {
      if (supabase) {
        const [profile, transactions, activeSessions, ownHost] = await Promise.all([secureApi('/api/me'), secureApi('/api/transactions'), secureApi('/api/vouchers/active'), secureApi('/api/hosts/mine')])
        const user={...profile,balance:Number(profile.wallet_balance)}
        const txs=transactions.map(t=>({...t,date:t.created_at,label:t.type.replaceAll('_',' '),type:['wallet_credit','host_earning','refund'].includes(t.type)?'credit':'debit'}))
        const own=ownHost?[{...ownHost,ownerId:ownHost.user_id,name:ownHost.business_name,area:ownHost.address||'Your hotspot',price:Number(ownHost.voucher_fee),speed:ownHost.speed_mbps,distance:0,rating:5,reviews:0,spots:ownHost.capacity,online:ownHost.is_online,verified:ownHost.verified,avatar:ownHost.business_name.slice(0,2).toUpperCase(),production:true}]:[]
        setDashboard({user,nearby:[],transactions:txs,bookings:activeSessions});setHosts(own);setBookings(activeSessions.map(s=>({...s,hostName:s.hosts?.business_name,hours:Math.max(1,Math.round((new Date(s.expires_at)-new Date(s.starts_at))/3600000)),amount:Number(s.amount_paid),code:s.access_code})))
      } else {
        const [dash, hostList, bookingList] = await Promise.all([api('/api/dashboard'), api('/api/hosts'), api('/api/bookings')])
        setDashboard(dash); setHosts(hostList); setBookings(bookingList)
      }
    } catch (e) {
      setDashboard(current => current || EMPTY_DASHBOARD)
      setHosts(current => Array.isArray(current) ? current : [])
      setBookings(current => Array.isArray(current) ? current : [])
      notify(e.message, 'error')
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])
  useEffect(()=>{const params=new URLSearchParams(location.search);const reference=params.get('reference');if(supabase&&params.get('payment')==='callback'&&reference){secureApi(`/api/payments/verify/${encodeURIComponent(reference)}`).then(()=>{notify('Payment confirmed. Your wallet has been credited.');load();history.replaceState({},'',location.pathname)}).catch(e=>notify(e.message,'error'))}},[])
  const notify = (message, type = 'success') => { setToast({ message, type }); setTimeout(() => setToast(null), 3200) }

  if (loading) return <div className="splash"><Logo/><Loader2 className="spin"/></div>
  const safeDashboard = dashboard || EMPTY_DASHBOARD
  const user = safeDashboard?.user || EMPTY_DASHBOARD.user
  const nav = role === 'owner'
    ? [{id:'home',label:'Overview',icon:Home},{id:'explore',label:'My listing',icon:Radio},{id:'messages',label:'Inbox',icon:MessageCircle},{id:'activity',label:'Bookings',icon:Activity},{id:'profile',label:'Account',icon:UserRound}]
    : [{id:'home',label:'Home',icon:Home},{id:'explore',label:'Find WiFi',icon:Search},{id:'activity',label:'Activity',icon:Activity},{id:'profile',label:'Account',icon:UserRound}]

  const pageProps = { user, dashboard: safeDashboard, hosts: hosts || [], bookings: bookings || [], setPage, setModal, notify, reload: load, role }
  return <div className="app-shell">
    <aside className="sidebar">
      <Logo/>
      <nav>{nav.map(({id,label,icon:Icon}) => <button key={id} className={page===id?'active':''} onClick={()=>setPage(id)}><Icon size={20}/><span>{label}</span></button>)}</nav>
      <div className="side-spacer"/>
      <button className="support"><CircleHelp size={20}/> Help & support</button>
      <div className="user-mini"><div className="avatar">TA</div><div><b>{user.name}</b><small>{role === 'owner' ? 'Starlink owner' : 'Customer'}</small></div><ChevronRight size={18}/></div>
    </aside>
    <main className="main">
      <header>
        <button className="mobile-logo"><Logo compact/></button>
        <div className="role-switch"><button className={role==='customer'?'selected':''} onClick={()=>{setRole('customer');setPage('home')}}>Find internet</button><button className={role==='owner'?'selected':''} onClick={()=>{setRole('owner');setPage('home')}}>Host dashboard</button></div>
        <div className="header-actions"><button className="icon-btn"><Bell size={20}/><i/></button><div className="avatar">TA</div></div>
      </header>
      <div className="page-wrap">
        {page === 'home' && (role === 'customer' ? <HomePage {...pageProps}/> : <OwnerHome {...pageProps}/>)}
        {page === 'explore' && (role === 'customer' ? <ExplorePage {...pageProps}/> : <OwnerListing {...pageProps}/>)}
        {page === 'messages' && role === 'owner' && <><div className="page-heading"><p className="eyebrow">REAL-TIME SUPPORT</p><h1>Customer inbox</h1><p>Reply to guests connected to your hotspot.</p></div><HostInbox currentUserId={user.id}/></>}
        {page === 'activity' && <ActivityPage {...pageProps}/>}
        {page === 'profile' && <ProfilePage {...pageProps}/>} 
      </div>
    </main>
    <nav className="bottom-nav">{nav.map(({id,label,icon:Icon}) => <button key={id} className={page===id?'active':''} onClick={()=>setPage(id)}><Icon size={21}/><span>{label}</span></button>)}</nav>
    {modal?.type === 'topup' && (import.meta.env.VITE_SUPABASE_URL ? <ProductionTopUp close={()=>setModal(null)}/> : <TopUpModal user={user} close={()=>setModal(null)} success={()=>{setModal(null);notify('Wallet funded successfully');load()}}/>)}
    {modal?.type === 'support' && <SupportModal activeSession={modal.session} close={()=>setModal(null)}/>}
    {modal?.type === 'message' && <MessageHostModal session={modal.session} currentUserId={user.id} close={()=>setModal(null)}/>}
    {modal?.type === 'book' && <BookingModal host={modal.host} user={user} close={()=>setModal(null)} success={(booking)=>{setModal({type:'confirmed',booking});load()}}/>}
    {modal?.type === 'confirmed' && <ConfirmedModal booking={modal.booking} close={()=>setModal(null)}/>} 
    {modal?.type === 'host' && <HostModal close={()=>setModal(null)} success={()=>{setModal(null);notify('Your hotspot is now listed');load()}}/>}
    {toast && <div className={`toast ${toast.type}`}><span>{toast.type==='error'?<X size={17}/>:<Check size={17}/>}</span>{toast.message}</div>}
  </div>
}

function SectionTitle({ title, action, onClick }) { return <div className="section-title"><h2>{title}</h2>{action&&<button onClick={onClick}>{action}<ArrowRight size={16}/></button>}</div> }

function HomePage({ user, dashboard, setPage, setModal }) {
  return <>
    <div className="welcome"><div><p className="eyebrow">FRIDAY, 24 JULY</p><h1>Good afternoon, Tomi <span>👋</span></h1><p>Ready to get connected?</p></div><button className="primary desktop-cta" onClick={()=>setPage('explore')}><Search size={19}/> Find nearby WiFi</button></div>
    <section className="wallet-card">
      <div className="wallet-orb orb-one"/><div className="wallet-orb orb-two"/>
      <div className="wallet-head"><span><Wallet size={18}/> LASTBORNK WALLET</span><button><ShieldCheck size={17}/> Secured</button></div>
      <div className="balance-label">Available balance</div><div className="balance">{money(user.balance)}<small>.00</small></div>
      <div className="wallet-actions"><button onClick={()=>setModal({type:'topup'})}><span><Plus size={19}/></span>Add money</button><button onClick={()=>setPage('activity')}><span><Activity size={19}/></span>Transactions</button></div>
    </section>
    <button className="find-banner" onClick={()=>setPage('explore')}><span className="find-icon"><Navigation size={24}/></span><span><b>Find Starlink near you</b><small>Fast, reliable internet is closer than you think</small></span><ChevronRight/></button>
    <SectionTitle title="Nearby hotspots" action="See all" onClick={()=>setPage('explore')}/>
    {(dashboard?.nearby ?? []).length > 0 ? <div className="host-grid">{(dashboard?.nearby ?? []).map(host=><HostCard key={host.id} host={host} onBook={()=>setModal({type:'book',host})}/>)}</div> : <div className="empty compact-empty"><Wifi size={30}/><h3>No nearby hotspots yet</h3><p>Use Find nearby WiFi to search live hosts around your current location.</p></div>}
    <SectionTitle title="Recent activity" action="View history" onClick={()=>setPage('activity')}/>
    {(dashboard?.transactions ?? []).length > 0 ? <div className="activity-list compact">{(dashboard?.transactions ?? []).slice(0,3).map(tx=><Transaction key={tx.id} tx={tx}/>)}</div> : <div className="empty compact-empty"><Activity size={30}/><h3>No activity yet</h3><p>Wallet funding and internet sessions will appear here.</p></div>}
  </>
}

function HostCard({ host, onBook }) {
  return <article className={`host-card ${!host.online?'offline':''}`}>
    <div className="host-top"><div className="host-avatar">{host.avatar}<span className={host.online?'online':''}/></div><div className="host-main"><h3>{host.name}{host.verified&&<BadgeCheck size={17}/>}</h3><p><MapPin size={14}/>{host.area}</p></div><button className="more"><Menu size={18}/></button></div>
    <div className="host-stats"><span><Navigation size={15}/><b>{host.distance} km</b> away</span><span><Gauge size={15}/><b>{host.speed}</b> Mbps</span><span><Star size={15} fill="currentColor"/><b>{host.rating}</b> ({host.reviews})</span></div>
    <div className="host-bottom"><div><b>{money(host.price)}</b><span> / hour</span><small>{host.spots ? `${host.spots} spots available` : 'Currently full'}</small></div><button disabled={!host.online || !host.spots} onClick={onBook}>{host.online&&host.spots?'Connect':'Unavailable'}</button></div>
  </article>
}

function ExplorePage({ hosts, setModal, notify }) {
  const [query, setQuery] = useState(''); const [sort,setSort] = useState('distance'); const [maxPrice,setMaxPrice] = useState(1000); const [nearby,setNearby]=useState(null); const [locating,setLocating]=useState(false)
  const findNearby=async()=>{setLocating(true);try{const {latitude,longitude}=await getCurrentPosition();const rows=await secureApi(`/api/hosts/nearby?lat=${latitude}&lng=${longitude}&radius=15000`);setNearby(rows.map(h=>({id:h.id,ownerId:h.user_id,name:h.business_name,area:h.address||'Nearby hotspot',address:h.address,distance:Number(h.distance_km),price:Number(h.voucher_fee),speed:h.speed_mbps,rating:5,reviews:0,spots:1,verified:h.verified,online:h.is_online,avatar:h.business_name.slice(0,2).toUpperCase(),production:true})));notify(`Found ${rows.length} live hotspot${rows.length===1?'':'s'} near you`)}catch(e){notify(e.message,'error')}finally{setLocating(false)}}
  const source=nearby||hosts
  const filtered = useMemo(()=>source.filter(h=>`${h.name} ${h.area}`.toLowerCase().includes(query.toLowerCase())&&h.price<=maxPrice).sort((a,b)=>sort==='price'?a.price-b.price:sort==='rating'?b.rating-a.rating:a.distance-b.distance),[source,query,sort,maxPrice])
  return <>
    <div className="page-heading"><p className="eyebrow">EXPLORE</p><h1>Find nearby Starlink</h1><p>Choose a trusted host and get online in minutes.</p></div>
    <div className="search-panel"><div className="searchbox"><Search size={20}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search an area or hotspot"/><button onClick={findNearby} disabled={locating}>{locating?<Loader2 className="spin" size={19}/>:<LocateFixed size={19}/>}<span>{locating?'Locating…':'Use my location'}</span></button></div><div className="filters"><button className={sort==='distance'?'active':''} onClick={()=>setSort('distance')}>Nearest</button><button className={sort==='rating'?'active':''} onClick={()=>setSort('rating')}>Top rated</button><button className={sort==='price'?'active':''} onClick={()=>setSort('price')}>Lowest price</button><label><SlidersHorizontal size={16}/> Under {money(maxPrice)}<input type="range" min="250" max="1000" step="50" value={maxPrice} onChange={e=>setMaxPrice(+e.target.value)}/></label></div></div>
    <div className="results-line"><b>{filtered.length} hotspots nearby</b><span><span className="live-dot"/> Live availability</span></div>
    <div className="explore-list">{filtered.map(h=><HostCard key={h.id} host={h} onBook={()=>setModal({type:'book',host:h})}/>)}</div>
    {!filtered.length&&<div className="empty"><Search size={34}/><h3>No hotspots found</h3><p>Try changing your search or price filter.</p></div>}
  </>
}

function Transaction({ tx }) { const credit=tx.type==='credit'; return <div className="transaction"><span className={`tx-icon ${credit?'credit':'debit'}`}>{credit?<ArrowDownLeft/>:<ArrowUpRight/>}</span><div><b>{tx.label}</b><small>{formatDate(tx.date)}</small></div><strong className={credit?'positive':''}>{credit?'+':'−'}{money(tx.amount)}</strong></div> }

function ActivityPage({ bookings, dashboard, role, setModal }) {
  const [tab,setTab]=useState('bookings')
  return <><div className="page-heading"><p className="eyebrow">YOUR HISTORY</p><h1>{role==='owner'?'Guest bookings':'Activity'}</h1><p>{role==='owner'?'See customer sessions and earnings.':'All your sessions and wallet movements in one place.'}</p></div>
    <div className="tabs"><button className={tab==='bookings'?'active':''} onClick={()=>setTab('bookings')}>Sessions</button><button className={tab==='transactions'?'active':''} onClick={()=>setTab('transactions')}>Transactions</button></div>
    {tab==='bookings' ? ((bookings ?? []).length > 0 ? <div className="booking-list">{(bookings ?? []).map(b=><div className="booking-row" key={b.id}><span className="booking-icon"><Wifi/></span><div><h3>{b.hostName || b.hosts?.business_name || 'Starlink session'}</h3><p>{formatDate(b.date || b.created_at)} · {b.hours || 1} hour{(b.hours || 1)>1?'s':''}</p><small className={`status ${b.status}`}>{b.status}</small></div><div className="booking-amount"><b>{money(b.amount||b.amount_paid)}</b><span>{b.code||b.access_code}</span></div>{b.status==='active'&&<button className="secondary" onClick={()=>setModal({type:'message',session:b})}><MessageCircle size={15}/> Message Host</button>}</div>)}</div> : <div className="empty compact-empty"><Wifi size={30}/><h3>No sessions yet</h3><p>Your purchased WiFi sessions will appear here.</p></div>) : ((dashboard?.transactions ?? []).length > 0 ? <div className="activity-list">{(dashboard?.transactions ?? []).map(tx=><Transaction key={tx.id} tx={tx}/>)}</div> : <div className="empty compact-empty"><Activity size={30}/><h3>No transactions yet</h3><p>Wallet and voucher transactions will appear here.</p></div>)}
  </>
}

function OwnerHome({ user, hosts = [], bookings = [], setModal, setPage }) {
  const listing=hosts.find(h=>h.ownerId===user?.id) || hosts[0]; const earnings=bookings.reduce((s,b)=>s+Number(b.amount || b.amount_paid || 0),0)
  return <><div className="welcome"><div><p className="eyebrow">HOST DASHBOARD</p><h1>Welcome back, Tomi</h1><p>Here’s how your Starlink is doing.</p></div><button className="primary" onClick={()=>setModal({type:'host'})}><Plus size={19}/> Add hotspot</button></div>
  <div className="metric-grid"><div className="metric blue"><span><Wallet/></span><p>Total earnings</p><h2>{money(earnings)}</h2><small>+12.4% this month</small></div><div className="metric"><span><Users/></span><p>Total sessions</p><h2>{bookings.length}</h2><small>2 this week</small></div><div className="metric"><span><Gauge/></span><p>Average speed</p><h2>{listing?.speed||168} <small>Mbps</small></h2><small>Excellent connection</small></div></div>
  <SectionTitle title="Your hotspot" action="Manage" onClick={()=>setPage('explore')}/>{listing?<HostCard host={listing} onBook={()=>{}}/>:<div className="owner-empty"><span><Radio/></span><h3>List your Starlink</h3><p>Turn spare bandwidth into income by sharing securely with people nearby.</p><button className="primary" onClick={()=>setModal({type:'host'})}>Create listing</button></div>}
  <SectionTitle title="Recent guest sessions" action="See all" onClick={()=>setPage('activity')}/><div className="booking-list">{bookings.slice(0,2).map(b=><div className="booking-row" key={b.id}><span className="booking-icon"><UserRound/></span><div><h3>Verified guest</h3><p>{formatDate(b.date)} · {b.hours} hour session</p></div><div className="booking-amount"><b className="positive">+{money(b.amount)}</b><span>Completed</span></div></div>)}</div></>
}

function OwnerListing({ hosts = [], user, setModal, notify, reload }) {
  const listing=hosts.find(h=>h.ownerId===user?.id) || hosts[0]
  const toggle=async()=>{try{if(listing.production)await secureApi(`/api/hosts/${listing.id}`,{method:'PATCH',body:JSON.stringify({isOnline:!listing.online})});else await api(`/api/hosts/${listing.id}`,{method:'PATCH',body:JSON.stringify({online:!listing.online})});notify(listing.online?'Hotspot paused':'Hotspot is now live');reload()}catch(e){notify(e.message,'error')}}
  return <><div className="welcome"><div><p className="eyebrow">HOST SETTINGS</p><h1>My hotspot</h1><p>Control availability, pricing and guest access.</p></div>{!listing&&<button className="primary" onClick={()=>setModal({type:'host'})}><Plus/> Add hotspot</button>}</div>
  {listing?<div className="listing-detail"><div className="listing-status"><div><span className={listing.online?'live-dot':''}/><b>{listing.online?'Your hotspot is live':'Your hotspot is paused'}</b><p>{listing.online?'Customers nearby can discover and book it.':'Your listing is hidden from customers.'}</p></div><button className={`switch ${listing.online?'on':''}`} onClick={toggle}><i/></button></div><HostCard host={listing} onBook={()=>{}}/><div className="settings-grid"><div><span><CreditCard/></span><p>Hourly price</p><b>{money(listing.price)}</b></div><div><span><Users/></span><p>Guest capacity</p><b>{listing.spots} available</b></div><div><span><Gauge/></span><p>Advertised speed</p><b>{listing.speed} Mbps</b></div></div><button className="secondary wide" onClick={()=>setModal({type:'host'})}><Settings size={18}/> Edit listing details</button></div>:<div className="owner-empty"><Radio/><h3>No hotspot yet</h3><p>Create your first listing to start earning.</p></div>}</>
}

function ProfilePage({ user, role, setModal }) {
  return <><div className="page-heading"><p className="eyebrow">SETTINGS</p><h1>Account</h1><p>Manage your profile, payments and security.</p></div><div className="profile-card"><div className="profile-head"><div className="avatar large">TA</div><div><h2>{user.name}</h2><p>{user.email}</p><span><BadgeCheck size={15}/> Identity verified</span></div><button className="secondary">Edit profile</button></div></div>
  <div className="settings-list"><button onClick={()=>setModal({type:'topup'})}><span><Wallet/></span><div><b>Wallet & payments</b><small>Balance: {money(user.balance)}</small></div><ChevronRight/></button><button><span><ShieldCheck/></span><div><b>Security & privacy</b><small>Password, identity and data</small></div><ChevronRight/></button><button><span><Bell/></span><div><b>Notifications</b><small>Bookings, payments and offers</small></div><ChevronRight/></button>{role==='owner'&&<button><span><Store/></span><div><b>Host verification</b><small>Complete your owner profile</small></div><ChevronRight/></button>}<button onClick={()=>setModal({type:'support'})}><span><CircleHelp/></span><div><b>Help & support</b><small>Open a customer care ticket</small></div><ChevronRight/></button><button className="danger"><span><LogOut/></span><div><b>Log out</b><small>Sign out of this device</small></div><ChevronRight/></button></div><p className="version">Lastbornk v1.0.0 · Made with care in Nigeria 🇳🇬</p></>
}

function Modal({ children, close, size='' }) { return <div className="modal-backdrop" onMouseDown={e=>e.target===e.currentTarget&&close()}><div className={`modal ${size}`}><button className="modal-close" onClick={close}><X/></button>{children}</div></div> }
function TopUpModal({user,close,success}) { const [amount,setAmount]=useState(5000); const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const submit=async()=>{setBusy(true);setError('');try{await api('/api/wallet/topup',{method:'POST',body:JSON.stringify({amount})});success()}catch(e){setError(e.message)}finally{setBusy(false)}}; return <Modal close={close}><div className="modal-icon"><Wallet/></div><h2>Add money</h2><p>Fund your Lastbornk wallet securely.</p><label className="field-label">Amount</label><div className="amount-input"><span>₦</span><input type="number" min="100" value={amount} onChange={e=>setAmount(+e.target.value)}/></div><div className="quick-amounts">{[1000,2000,5000,10000].map(n=><button className={amount===n?'active':''} onClick={()=>setAmount(n)} key={n}>{money(n)}</button>)}</div><div className="pay-source"><span><CreditCard/></span><div><b>•••• 4482</b><small>Visa debit card</small></div><Check/></div>{error&&<p className="form-error">{error}</p>}<button className="primary wide" onClick={submit} disabled={busy}>{busy?<Loader2 className="spin"/>:`Add ${money(amount)}`}</button><small className="safe"><ShieldCheck/> Payment secured with encryption</small></Modal> }

function BookingModal({host,user,close,success}) { const [hours,setHours]=useState(1); const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const total=hours*host.price; const submit=async()=>{setBusy(true);setError('');try{if(host.production){const params=new URLSearchParams(location.search);const d=await secureApi('/api/vouchers/purchase',{method:'POST',body:JSON.stringify({hostId:host.id,clientMac:params.get('mac')||null,durationMinutes:hours*60,speedProfile:'5M/5M'})});success({...d.session,code:d.session.access_code,hostName:host.name,hours,amount:Number(d.session.amount_paid),routerLogin:d.routerLogin})}else{const d=await api('/api/bookings',{method:'POST',body:JSON.stringify({hostId:host.id,hours})});success(d.booking)}}catch(e){setError(e.message)}finally{setBusy(false)}}; return <Modal close={close} size="booking-modal"><p className="eyebrow">CONFIRM CONNECTION</p><div className="book-host"><div className="host-avatar">{host.avatar}</div><div><h2>{host.name}</h2><p><MapPin size={14}/>{host.area} · {host.distance} km away</p></div></div><div className="connection-stats"><span><Gauge/><b>{host.speed} Mbps</b><small>Speed</small></span><span><Star/><b>{host.rating}</b><small>Rating</small></span><span><Users/><b>{host.spots}</b><small>Spots left</small></span></div><label className="field-label">How long do you need?</label><div className="duration-pills">{[1,2,3,5].map(n=><button className={hours===n?'active':''} onClick={()=>setHours(n)} key={n}>{n} hr{n>1?'s':''}</button>)}</div><div className="order-summary"><div><span>{money(host.price)} × {hours} hour{hours>1?'s':''}</span><b>{money(total)}</b></div><div><span>Service fee</span><b>₦0</b></div><div className="total"><span>Total</span><b>{money(total)}</b></div></div><div className="wallet-pay"><Wallet/><div><b>Lastbornk wallet</b><small>Balance: {money(user.balance)}</small></div><Check/></div>{error&&<p className="form-error">{error}</p>}<button className="primary wide" onClick={submit} disabled={busy}>{busy?<Loader2 className="spin"/>:`Pay ${money(total)} & connect`}</button></Modal> }
function ConfirmedModal({booking,close}) { const loginUrl=new URLSearchParams(location.search).get('loginUrl'); const connect=()=>{if(loginUrl&&booking.routerLogin)submitRouterLogin(loginUrl,booking.routerLogin.username,booking.routerLogin.password);else close()}; return <Modal close={close}><div className="success-ring"><Check/></div><h2>You're connected!</h2><p>{loginUrl?'Your voucher is ready. Continue to authenticate this device.':'Show this access code to the host when you arrive.'}</p><div className="access-code"><span>ACCESS CODE</span><strong>{booking.code}</strong></div><div className="confirm-info"><Wifi/><div><b>{booking.hostName}</b><small>{booking.hours} hour session · {money(booking.amount)}</small></div></div><button className="primary wide" onClick={connect}>{loginUrl?'Connect to WiFi':'Done'}</button></Modal> }
function HostModal({close,success}) { const [form,setForm]=useState({name:'Tomi’s Starlink Spot',area:'GRA, Benin City',address:'',price:500,speed:150,spots:5,routerMac:''}); const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const update=e=>setForm({...form,[e.target.name]:e.target.value}); const submit=async()=>{setBusy(true);setError('');try{if(supabase){const pos=await getCurrentPosition();await secureApi('/api/hosts',{method:'POST',body:JSON.stringify({businessName:form.name,address:`${form.address}, ${form.area}`,routerMac:form.routerMac,latitude:pos.latitude,longitude:pos.longitude,voucherFee:Number(form.price),speedMbps:Number(form.speed),capacity:Number(form.spots),isOnline:true})})}else await api('/api/hosts',{method:'POST',body:JSON.stringify(form)});success()}catch(e){setError(e.message)}finally{setBusy(false)}}; return <Modal close={close} size="booking-modal"><p className="eyebrow">BECOME A HOST</p><h2>List your Starlink</h2><p>Share reliable internet and earn from every session. Your current GPS position is used when publishing.</p><div className="form-grid"><label><span>Hotspot name</span><input name="name" value={form.name} onChange={update}/></label><label><span>Area</span><input name="area" value={form.area} onChange={update}/></label><label className="full"><span>Meeting address</span><input name="address" value={form.address} onChange={update} placeholder="Visible after a customer books"/></label><label className="full"><span>MikroTik router MAC</span><input name="routerMac" value={form.routerMac} onChange={update} placeholder="AA:BB:CC:DD:EE:FF"/></label><label><span>Price per hour (₦)</span><input type="number" name="price" value={form.price} onChange={update}/></label><label><span>Speed (Mbps)</span><input type="number" name="speed" value={form.speed} onChange={update}/></label><label className="full"><span>Available guest spots</span><input type="number" name="spots" value={form.spots} onChange={update}/></label></div>{error&&<p className="form-error">{error}</p>}<button className="primary wide" onClick={submit} disabled={busy}>{busy?<Loader2 className="spin"/>:'Publish hotspot'}</button></Modal> }

function AuthScreen() {
  const [phone,setPhone]=useState('+234'),[name,setName]=useState(''),[email,setEmail]=useState(''),[token,setToken]=useState(''),[sent,setSent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const submit=async e=>{e.preventDefault();setBusy(true);setError('');try{if(!sent){const{error}=await supabase.auth.signInWithOtp({phone,options:{data:{name,email}}});if(error)throw error;setSent(true)}else{const{error}=await supabase.auth.verifyOtp({phone,token,type:'sms'});if(error)throw error}}catch(e){setError(e.message)}finally{setBusy(false)}}
  return <div className="auth-page"><div className="auth-card"><Logo/><p className="eyebrow">SECURE ACCESS</p><h1>{sent?'Enter your code':'Welcome to Lastbornk'}</h1><p>{sent?`We sent a six-digit code to ${phone}`:'Sign in with your Nigerian phone number.'}</p><form onSubmit={submit}>{!sent&&<><label><span>Your name</span><input required value={name} onChange={e=>setName(e.target.value)} placeholder="Tomi Aigbe"/></label><label><span>Email for payment receipts</span><input required type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="tomi@example.com"/></label></>}<label><span>{sent?'Verification code':'Phone number'}</span><input required value={sent?token:phone} onChange={e=>sent?setToken(e.target.value):setPhone(e.target.value)} placeholder={sent?'123456':'+2348030000000'}/></label>{error&&<p className="form-error">{error}</p>}<button className="primary wide" disabled={busy}>{busy?<Loader2 className="spin"/>:sent?'Verify and continue':'Send login code'}</button></form>{sent&&<button className="text-btn" onClick={()=>setSent(false)}>Use another number</button>}</div></div>
}
function Root(){const[session,setSession]=useState(undefined);useEffect(()=>{if(!supabase){setSession(null);return}supabase.auth.getSession().then(({data})=>setSession(data.session));const{data:{subscription}}=supabase.auth.onAuthStateChange((_event,next)=>setSession(next));return()=>subscription.unsubscribe()},[]);if(session===undefined)return <div className="splash"><Logo/><Loader2 className="spin"/></div>;if(supabase&&!session)return <AuthScreen/>;return <App/>}

createRoot(document.getElementById('root')).render(<React.StrictMode><Root/></React.StrictMode>)
