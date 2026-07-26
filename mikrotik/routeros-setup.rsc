# Lastbornk MikroTik HotSpot + central RADIUS setup template
# Replace CAPITALIZED values before importing. Run from RouterOS terminal.

/radius add service=hotspot address=RADIUS_SERVER_IP secret=RADIUS_SHARED_SECRET authentication-port=1812 accounting-port=1813 timeout=3s
/radius incoming set accept=yes
/ip hotspot profile set [find name="default"] use-radius=yes radius-accounting=yes radius-interim-update=1m login-by=http-pap,cookie html-directory=hotspot
/ip hotspot user profile add name=lastbornk-default shared-users=1 idle-timeout=5m keepalive-timeout=2m rate-limit="5M/5M"

# Allow captive clients to reach the application before authentication.
/ip hotspot walled-garden add dst-host=app.lastbornk.ng action=allow comment="Lastbornk captive app"
/ip hotspot walled-garden add dst-host=*.supabase.co action=allow comment="Supabase auth/API"
/ip hotspot walled-garden add dst-host=checkout.paystack.com action=allow comment="Paystack checkout"
/ip hotspot walled-garden add dst-host=api.paystack.co action=allow comment="Paystack API redirect"

# Set a unique identity that matches hosts.router_identity in Supabase.
/system identity set name="LASTBORNK_HOST_ROUTER_ID"

# Upload mikrotik/hotspot/login.html and logout.html into Files > hotspot/.
# In login.html replace HOST_UUID and https://app.lastbornk.ng with real values.
