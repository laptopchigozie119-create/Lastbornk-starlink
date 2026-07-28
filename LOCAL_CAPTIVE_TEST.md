# Free local captive-portal test — Windows laptop + phone

This kit tests the complete identity/PIN loop without a MikroTik or Starlink:

1. Phone joins the laptop's Windows Mobile Hotspot.
2. Phone opens the local Lastbornk portal hosted by the laptop.
3. User verifies the same Lastbornk phone account by OTP.
4. User enters the purchased six-digit voucher PIN.
5. The local portal proxies the request to the deployed `/api/captive/claim` endpoint.
6. The API checks the real Supabase `vouchers_sessions` row and changes it to Connected.

## One-time setup

Open `local-captive/config.json` in Notepad and replace:

```text
https://YOUR-VERCEL-DOMAIN
```

with the real deployed URL, for example `https://your-app.vercel.app`. The Supabase URL and publishable key in this file are public browser configuration, not secret credentials.

No router key, Supabase service key, Paystack key, or network secret is needed on the laptop.

## Run on Windows

1. Install Node.js if it is not already installed.
2. In Windows Settings, open **Network & internet → Mobile hotspot**.
3. Share the laptop's existing Wi-Fi connection over Wi-Fi and turn Mobile hotspot on.
4. Right-click `local-captive/start-windows.ps1` and choose **Run with PowerShell**. If Windows blocks the inbound connection, run it once as Administrator so it can add the firewall rule.
5. Connect the phone to the Windows hotspot name/password.
6. Open the URL printed in the PowerShell window, usually:

   ```text
   http://192.168.137.1:8787
   ```

7. Sign in by OTP, enter a six-digit voucher PIN purchased by that account, and tap **Connect to test Wi-Fi**.

## Important Windows limitation

Windows Mobile Hotspot/ICS does not provide a supported, free mechanism for transparent DNS hijacking and HTTP redirection. Therefore Windows cannot reliably force Android/iOS to pop open this local page automatically while it is also sharing working internet. The provided page accurately tests the captive login, Supabase PIN validation, and session transition, but you open its local URL manually.

A true automatic captive-popup test requires control over DHCP, DNS, and firewall redirects—normally MikroTik/OpenWrt, or Linux with hostapd + dnsmasq + nftables. WSL2 and Docker Desktop cannot reliably control the Windows Wi-Fi adapter at that layer. Do not install unknown packet interception drivers merely to fake this behavior.

The local server includes common captive probe paths (`/generate_204`, `/hotspot-detect.html`, `/ncsi.txt`), so the same portal can later sit behind a Linux/OpenWrt DNS redirect and trigger the operating-system captive assistant.

## Troubleshooting

- **Phone cannot open the local URL:** run the PowerShell script as Administrator, confirm the phone is connected to the Windows hotspot, and confirm the printed IP with `192.168.137.x`.
- **OTP error:** confirm Supabase Phone Auth/SMS provider is enabled.
- **PIN rejected:** ensure the PIN belongs to the signed-in account, has not expired, and the hotspot is online.
- **404 on claim:** wait for the Vercel deployment containing `/api/captive/claim`.
- **The phone uses mobile data:** keep Wi-Fi connected; the portal itself is local, while the laptop proxies cloud requests.

## Security

The claim endpoint requires a valid Supabase user JWT and only accepts a voucher owned by that user. It is available only while mock mode is active. The local server never receives or stores server-side Supabase or Paystack secrets.
