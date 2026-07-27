# Lastbornk

A decentralized Starlink bandwidth-sharing web application with a prepaid Nigerian wallet, nearby hotspot discovery, real-time host messaging, support ticketing, and MikroTik captive-portal integration.

## Production capabilities

- Supabase Phone Auth, PostgreSQL, PostGIS, Row Level Security, and Realtime
- Atomic wallet debit, host earning, voucher issuance, and transaction audit feed
- Paystack hosted checkout with raw-body HMAC-SHA512 webhook verification
- Browser geolocation and indexed distance search
- Time-limited, MAC-bound hotspot vouchers
- Customer ↔ host real-time chat and host inbox
- Customer-care tickets and protected admin operations
- MikroTik external captive redirect and FreeRADIUS REST authorization
- Responsive customer and host dashboards

## Run

```bash
cp .env.example .env
npm install
npm run dev
```

- Frontend: `http://localhost:5173`
- API: `http://localhost:4000`

Without Supabase keys, the original JSON demo remains available. With configured Supabase and Paystack credentials, secure production flows are enabled and phone authentication is required.

## Setup guide

Read **[PRODUCTION_SETUP.md](./PRODUCTION_SETUP.md)** before connecting live credentials or physical routers.

Key files:

- `supabase/migrations/001_lastbornk.sql` — complete schema, RLS, spatial function, and atomic wallet RPCs
- `server/payments.js` — Paystack initialize, verify, and webhook
- `server/api.js` — hosts, proximity, voucher, messaging, ticket, admin, and RADIUS APIs
- `src/components/NetworkFeatures.jsx` — payments, messaging, inbox, and support UI
- `mikrotik/` — captive portal, RouterOS, and FreeRADIUS templates

## Build

```bash
npm run build
npm start
```

The Express server serves the production build from `dist/`.

## Vercel

`vercel.json` builds the Vite frontend, serves SPA routes from `index.html`, and forwards `/api/*` to the Express serverless entry point at `api/index.js`. Configure Paystack's webhook URL as `https://YOUR_VERCEL_DOMAIN/api/payments/webhook`.

Configure these server-side variables in **Vercel → Project Settings → Environment Variables**, then redeploy:

```text
SUPABASE_SECRET_KEY
PAYSTACK_SECRET_KEY
APP_URL=https://YOUR_VERCEL_DOMAIN
ADMIN_API_KEY
NETWORK_SHARED_SECRET
```

The Supabase URL and publishable key have safe public defaults in the client, but can still be overridden with `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`, and `SUPABASE_PUBLISHABLE_KEY`.

> This is a production-oriented technical scaffold, not a claim of financial or telecommunications regulatory approval. Complete security testing, monitoring, reconciliation, NDPA review, and payment/network compliance before processing real funds.
