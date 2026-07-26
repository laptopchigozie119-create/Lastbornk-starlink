-- Development seed template. First create users through Supabase Auth,
-- then replace these UUIDs with real auth.users IDs.
insert into public.hosts(user_id,business_name,latitude,longitude,address,router_mac,router_identity,is_online,voucher_fee,speed_mbps,verified)
values
('HOST_AUTH_USER_UUID','Osas Connect',6.3176,5.6037,'Boundary Road, GRA','AA:BB:CC:DD:EE:01','LBK-OSAS-01',true,300,100,true);
