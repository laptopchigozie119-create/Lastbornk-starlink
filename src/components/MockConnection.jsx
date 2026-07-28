import React, { useEffect, useState } from 'react'
import { Gauge, Loader2, Power, Radio, WifiOff } from 'lucide-react'
import { secureApi } from '../lib/supabase'

const money = (value) => `₦${Number(value || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`

export function MockConnection({ session, notify, reload }) {
  const [connected, setConnected] = useState(session.status === 'used')
  const [telemetry, setTelemetry] = useState({ mbps: 0, dataUsedGb: 0, usageValueNgn: 0, rateNgnPerGb: 100 })
  const [busy, setBusy] = useState(false)

  const refreshTelemetry = async () => {
    try {
      const data = await secureApi(`/api/vouchers/${session.id}/telemetry`)
      setTelemetry(data)
      setConnected(Boolean(data.connected))
    } catch { /* A later poll or page reload can recover. */ }
  }

  useEffect(() => {
    if (!connected) return undefined
    refreshTelemetry()
    const timer = setInterval(refreshTelemetry, 2500)
    return () => clearInterval(timer)
  }, [connected, session.id])

  const connect = async () => {
    setBusy(true)
    try {
      const data = await secureApi(`/api/vouchers/${session.id}/connect`, { method: 'POST' })
      setConnected(true)
      setTelemetry(data.connection)
      notify(`Connected to ${session.hostName || session.hosts?.business_name || 'hotspot'} successfully.`, 'success', 'connection')
      reload?.()
    } catch (error) { notify(error.message, 'error') }
    finally { setBusy(false) }
  }

  const disconnect = async () => {
    setBusy(true)
    try {
      const data = await secureApi(`/api/vouchers/${session.id}/disconnect`, { method: 'POST' })
      setConnected(false)
      setTelemetry(data.connection)
      notify(`Disconnected from ${session.hostName || session.hosts?.business_name || 'hotspot'}.`, 'success', 'connection')
      reload?.()
    } catch (error) { notify(error.message, 'error') }
    finally { setBusy(false) }
  }

  return <div className={`mock-connection ${connected ? 'connected' : ''}`}>
    <div className="connection-state">
      <span>{connected ? <Radio /> : <WifiOff />}</span>
      <div><b>{connected ? 'Connected' : 'Ready to connect'}</b><small>{connected ? 'Mock MikroTik session is live' : `PIN ${session.code || session.access_code}`}</small></div>
    </div>
    {connected && <div className="telemetry-strip">
      <span><Gauge /><b>{Number(telemetry.mbps || 0).toFixed(1)}</b><small>link Mbps</small></span>
      <span><b>{Number(telemetry.dataUsedGb || 0).toFixed(4)}</b><small>GB used · {Number(telemetry.usageMbps || 0).toFixed(2)} avg Mbps</small></span>
      <span><b>{money(telemetry.usageValueNgn)}</b><small>@ ₦{telemetry.rateNgnPerGb || 100}/GB</small></span>
    </div>}
    <button className={connected ? 'disconnect-btn' : 'connect-btn'} disabled={busy} onClick={connected ? disconnect : connect}>
      {busy ? <Loader2 className="spin" /> : <Power />}{connected ? 'Disconnect' : 'Connect'}
    </button>
  </div>
}
