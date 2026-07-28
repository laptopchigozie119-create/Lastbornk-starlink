# Lastbornk physical MikroTik setup

## Recommended topology: MikroTik → FreeRADIUS → Lastbornk API

A Vercel function cannot directly reach `192.168.x.x` on a host's LAN. Keep the router private and let it initiate RADIUS requests to a FreeRADIUS server reachable over a VPN (Tailscale/WireGuard) or a tightly firewalled public IP.

### 1. Cloud configuration

1. Apply `supabase/migrations/004_hardware_integration.sql`.
2. In Vercel set:
   - `MOCK_ROUTER_ENABLED=false`
   - `ROUTER_CREDENTIALS_KEY` to output from `openssl rand -base64 32`
   - `NETWORK_SHARED_SECRET` to a separate random value.
3. Redeploy.
4. Host Dashboard → My listing → **Configure physical router**.
5. Choose MikroTik, FreeRADIUS, enter a unique NAS identity such as `LBK-HOST-01`, and enable provisioning.

After payment, Lastbornk creates a six-digit PIN in `vouchers_sessions` and a `router_provision_jobs` row with status `ready`. No router password is exposed to the browser.

### 2. FreeRADIUS

Use the templates under `mikrotik/freeradius/`. The REST module calls:

```text
POST https://YOUR-VERCEL-DOMAIN/api/network/authorize
x-network-secret: NETWORK_SHARED_SECRET
```

It sends `User-Name`, `User-Password`, `Calling-Station-Id`, and `NAS-Identifier`. Lastbornk accepts only an active, unexpired voucher for the matching router identity and returns:

- `Mikrotik-Rate-Limit`
- `Session-Timeout`
- `Simultaneous-Use`

Add each router as a FreeRADIUS client with a unique RADIUS secret. Never reuse `NETWORK_SHARED_SECRET` as the router's RADIUS secret.

### 3. MikroTik

Edit/import `mikrotik/routeros-setup.rsc` and set:

- `RADIUS_SERVER_IP`
- `RADIUS_SHARED_SECRET`
- `LASTBORNK_HOST_ROUTER_ID` exactly equal to the Host Dashboard router identity.

Upload `mikrotik/hotspot/login.html` to the router's `hotspot/` directory. Replace `HOST_UUID` and the app domain. Add the app, Supabase, and Paystack domains to the HotSpot walled garden so an unauthenticated device can buy a voucher.

A completely different phone can then join the Wi-Fi, enter the generated PIN as both username and password, and be authenticated by FreeRADIUS against Lastbornk.

## Alternative: HTTPS controller webhook

For sites without FreeRADIUS, run `hardware/controller/mikrotik-controller.mjs` on a small LAN machine that can reach RouterOS REST. Put it behind trusted HTTPS and configure its `/vouchers` URL and shared controller secret in the Host Dashboard.

```bash
export LASTBORNK_CONTROLLER_SECRET='same value entered as API secret'
export MIKROTIK_REST_URL='https://192.168.88.1/rest'
export MIKROTIK_USER='lastbornk-provisioner'
export MIKROTIK_PASSWORD='strong-router-password'
export MIKROTIK_HOTSPOT_PROFILE='lastbornk-default'
node hardware/controller/mikrotik-controller.mjs
```

The API signs each exact JSON body with HMAC-SHA256 in `x-lastbornk-signature`. The controller verifies it and adds a time-limited HotSpot user through RouterOS REST.

### RouterOS REST preparation

Use RouterOS v7, install a trusted TLS certificate, enable HTTPS API, and create a least-privilege provisioning user. Restrict management access to the controller's IP/VPN. Do not expose WinBox, SSH, HTTP, or the RouterOS REST API directly to the internet.

## Production checks

- Test with Paystack test mode first.
- Confirm an expired PIN is rejected.
- Confirm a PIN from router A is rejected on router B.
- Confirm MAC binding and `Session-Timeout` work.
- Monitor `router_provision_jobs`, Vercel logs, FreeRADIUS logs, and router accounting.
- Add reconciliation/refund handling before real customer use.
