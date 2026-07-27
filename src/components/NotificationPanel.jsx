import React from 'react'
import { Bell, CheckCheck, CreditCard, Radio, TicketCheck, Wifi, X } from 'lucide-react'

const iconFor = (kind) => kind === 'deposit' ? CreditCard : kind === 'voucher' ? TicketCheck : kind === 'connection' ? Radio : Wifi

export function NotificationPanel({ notifications, close, markAllRead, clearAll }) {
  return <div className="notification-panel">
    <div className="notification-head"><div><Bell /><h3>Notifications</h3></div><button onClick={close}><X /></button></div>
    <div className="notification-tools"><button onClick={markAllRead}><CheckCheck /> Mark all read</button>{notifications.length > 0 && <button onClick={clearAll}>Clear</button>}</div>
    <div className="notification-feed">
      {notifications.length === 0 ? <div className="notification-empty"><Bell /><b>You're all caught up</b><small>Deposits, vouchers, and connection alerts will appear here.</small></div> : notifications.map(item => {
        const Icon = iconFor(item.kind)
        return <div className={`notification-item ${item.read ? '' : 'unread'}`} key={item.id}><span><Icon /></span><div><b>{item.title}</b><p>{item.message}</p><small>{new Date(item.createdAt).toLocaleString('en-NG', { day:'numeric', month:'short', hour:'numeric', minute:'2-digit' })}</small></div></div>
      })}
    </div>
  </div>
}
