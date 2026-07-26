-- Lastbornk production schema for Supabase/PostgreSQL
-- Run with: supabase db push  (or paste once into Supabase SQL Editor)

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists postgis with schema extensions;

create type public.session_status as enum ('active', 'used', 'expired', 'revoked');
create type public.ticket_status as enum ('open', 'in_progress', 'resolved');
create type public.transaction_type as enum ('wallet_credit', 'voucher_debit', 'host_earning', 'admin_adjustment', 'refund');
create type public.transaction_status as enum ('pending', 'successful', 'failed', 'reversed');
create type public.user_role as enum ('customer', 'host', 'admin');

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  phone text unique,
  email text,
  role public.user_role not null default 'customer',
  wallet_balance numeric(14,2) not null default 0 check (wallet_balance >= 0),
  created_at timestamptz not null default now()
);

create table public.hosts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users(id) on delete cascade,
  business_name text not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  location geography(point, 4326) generated always as (st_setsrid(st_makepoint(longitude, latitude), 4326)::geography) stored,
  address text,
  router_mac macaddr not null unique,
  router_identity text unique,
  is_online boolean not null default false,
  voucher_fee numeric(12,2) not null default 300 check (voucher_fee > 0),
  total_earnings numeric(14,2) not null default 0 check (total_earnings >= 0),
  speed_mbps integer not null default 50 check (speed_mbps > 0),
  capacity integer not null default 10 check (capacity > 0),
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index hosts_location_gix on public.hosts using gist(location);
create index hosts_online_idx on public.hosts(is_online) where is_online;

create table public.vouchers_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  host_id uuid not null references public.hosts(id) on delete cascade,
  access_code text not null unique,
  client_mac macaddr,
  speed_limit_profile text not null default '5M/5M',
  amount_paid numeric(12,2) not null check (amount_paid > 0),
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status public.session_status not null default 'active',
  created_at timestamptz not null default now(),
  check (expires_at > starts_at)
);
create index sessions_user_status_idx on public.vouchers_sessions(user_id, status);
create index sessions_host_status_idx on public.vouchers_sessions(host_id, status);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.users(id) on delete cascade,
  receiver_id uuid not null references public.users(id) on delete cascade,
  host_id uuid not null references public.hosts(id) on delete cascade,
  session_id uuid references public.vouchers_sessions(id) on delete set null,
  text text not null check (char_length(text) between 1 and 2000),
  read_at timestamptz,
  timestamp timestamptz not null default now(),
  check (sender_id <> receiver_id)
);
create index messages_room_idx on public.messages(host_id, sender_id, receiver_id, timestamp desc);
create index messages_unread_idx on public.messages(receiver_id, timestamp desc) where read_at is null;

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  host_id uuid references public.hosts(id) on delete set null,
  subject text not null check (subject in ('Payment Failed but Debited', 'Cannot Authenticate with Router', 'Hardware Offline', 'Slow or Unstable Connection', 'Other')),
  issue_description text not null check (char_length(issue_description) between 10 and 4000),
  status public.ticket_status not null default 'open',
  admin_notes text,
  assigned_to uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index tickets_status_idx on public.tickets(status, created_at desc);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  host_id uuid references public.hosts(id) on delete set null,
  session_id uuid references public.vouchers_sessions(id) on delete set null,
  type public.transaction_type not null,
  status public.transaction_status not null default 'successful',
  amount numeric(14,2) not null check (amount > 0),
  balance_after numeric(14,2),
  provider text,
  provider_reference text unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index transactions_user_created_idx on public.transactions(user_id, created_at desc);

create table public.payment_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  amount numeric(14,2) not null check (amount >= 100),
  currency text not null default 'NGN' check (currency = 'NGN'),
  provider text not null default 'paystack',
  reference text unique,
  status public.transaction_status not null default 'pending',
  paid_at timestamptz,
  provider_payload jsonb,
  created_at timestamptz not null default now()
);

-- New Supabase Auth users automatically receive a public wallet profile.
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.users(id, name, phone, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', ''), new.phone, coalesce(new.email, new.raw_user_meta_data ->> 'email'))
  on conflict (id) do nothing;
  return new;
end; $$;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_auth_user();

-- Geospatial discovery. Distance is returned in kilometres.
create or replace function public.find_nearby_hosts(
  user_lat double precision,
  user_lng double precision,
  radius_meters integer default 10000
) returns table (
  id uuid, user_id uuid, business_name text, latitude double precision,
  longitude double precision, address text, is_online boolean, voucher_fee numeric,
  speed_mbps integer, verified boolean, distance_km numeric
) language sql stable security invoker set search_path = '' as $$
  select h.id, h.user_id, h.business_name, h.latitude, h.longitude, h.address,
         h.is_online, h.voucher_fee, h.speed_mbps, h.verified,
         round((extensions.st_distance(h.location, extensions.st_setsrid(extensions.st_makepoint(user_lng, user_lat), 4326)::extensions.geography) / 1000)::numeric, 2)
  from public.hosts h
  where h.is_online = true
    and extensions.st_dwithin(h.location, extensions.st_setsrid(extensions.st_makepoint(user_lng, user_lat), 4326)::extensions.geography, radius_meters)
  order by h.location operator(extensions.<->) extensions.st_setsrid(extensions.st_makepoint(user_lng, user_lat), 4326)::extensions.geography;
$$;

-- Atomic wallet debit + host credit + voucher creation. Never perform these as separate API calls.
create or replace function public.purchase_voucher(
  p_host_id uuid,
  p_client_mac macaddr default null,
  p_duration_minutes integer default 60,
  p_speed_profile text default '5M/5M'
) returns public.vouchers_sessions
language plpgsql security definer set search_path = '' as $$
declare
  v_user public.users;
  v_host public.hosts;
  v_session public.vouchers_sessions;
  v_code text;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if p_duration_minutes < 15 or p_duration_minutes > 1440 then raise exception 'invalid duration'; end if;

  select * into v_user from public.users where id = auth.uid() for update;
  select * into v_host from public.hosts where id = p_host_id for update;
  if not found or not v_host.is_online then raise exception 'host unavailable'; end if;
  if v_host.user_id = auth.uid() then raise exception 'cannot purchase from your own hotspot'; end if;
  if v_user.wallet_balance < v_host.voucher_fee then raise exception 'insufficient wallet balance'; end if;

  v_code := upper(substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 12));
  update public.users set wallet_balance = wallet_balance - v_host.voucher_fee where id = auth.uid() returning * into v_user;
  update public.hosts set total_earnings = total_earnings + v_host.voucher_fee, updated_at = now() where id = p_host_id;

  insert into public.vouchers_sessions(user_id, host_id, access_code, client_mac, speed_limit_profile, amount_paid, expires_at)
  values (auth.uid(), p_host_id, v_code, p_client_mac, p_speed_profile, v_host.voucher_fee, now() + make_interval(mins => p_duration_minutes))
  returning * into v_session;

  insert into public.transactions(user_id, host_id, session_id, type, amount, balance_after)
  values (auth.uid(), p_host_id, v_session.id, 'voucher_debit', v_host.voucher_fee, v_user.wallet_balance);
  insert into public.transactions(user_id, host_id, session_id, type, amount, balance_after)
  values (v_host.user_id, p_host_id, v_session.id, 'host_earning', v_host.voucher_fee, null);
  return v_session;
end; $$;

-- Paystack webhook calls this with service-role credentials. Reference uniqueness makes retries idempotent.
create or replace function public.confirm_paystack_payment(
  p_intent_id uuid,
  p_reference text,
  p_amount numeric,
  p_payload jsonb
) returns numeric language plpgsql security definer set search_path = '' as $$
declare v_intent public.payment_intents; v_balance numeric;
begin
  select * into v_intent from public.payment_intents where id = p_intent_id for update;
  if not found then raise exception 'payment intent not found'; end if;
  if v_intent.amount <> p_amount or v_intent.currency <> 'NGN' then raise exception 'payment amount mismatch'; end if;
  if v_intent.status = 'successful' then
    select wallet_balance into v_balance from public.users where id = v_intent.user_id;
    return v_balance;
  end if;
  if exists(select 1 from public.transactions where provider_reference = p_reference) then raise exception 'reference already processed'; end if;

  update public.users set wallet_balance = wallet_balance + p_amount where id = v_intent.user_id returning wallet_balance into v_balance;
  update public.payment_intents set status='successful', reference=p_reference, paid_at=now(), provider_payload=p_payload where id=p_intent_id;
  insert into public.transactions(user_id, type, amount, balance_after, provider, provider_reference, metadata)
  values(v_intent.user_id, 'wallet_credit', p_amount, v_balance, 'paystack', p_reference, jsonb_build_object('intent_id', p_intent_id));
  return v_balance;
end; $$;

-- Atomic admin balance adjustment with an immutable audit transaction.
create or replace function public.admin_adjust_wallet(p_user_id uuid, p_amount numeric, p_reason text)
returns numeric language plpgsql security definer set search_path = '' as $$
declare v_balance numeric;
begin
  if not exists(select 1 from public.users where id=auth.uid() and role='admin') then raise exception 'admin role required'; end if;
  if p_amount = 0 or char_length(coalesce(p_reason,'')) < 5 then raise exception 'amount and reason required'; end if;
  update public.users set wallet_balance = wallet_balance + p_amount
  where id=p_user_id and wallet_balance + p_amount >= 0 returning wallet_balance into v_balance;
  if not found then raise exception 'user not found or resulting balance is negative'; end if;
  insert into public.transactions(user_id,type,amount,balance_after,metadata)
  values(p_user_id,'admin_adjustment',abs(p_amount),v_balance,jsonb_build_object('direction',case when p_amount>0 then 'credit' else 'debit' end,'reason',p_reason,'admin_id',auth.uid()));
  return v_balance;
end; $$;

-- Session expiry maintenance; invoke every minute with Supabase Cron.
create or replace function public.expire_voucher_sessions()
returns integer language plpgsql security definer set search_path = '' as $$
declare affected integer;
begin
  update public.vouchers_sessions set status='expired' where status='active' and expires_at <= now();
  get diagnostics affected = row_count;
  return affected;
end; $$;

-- RLS
alter table public.users enable row level security;
alter table public.hosts enable row level security;
alter table public.vouchers_sessions enable row level security;
alter table public.messages enable row level security;
alter table public.tickets enable row level security;
alter table public.transactions enable row level security;
alter table public.payment_intents enable row level security;

create policy "read own profile" on public.users for select using (id = auth.uid());
create policy "update own profile" on public.users for update using (id = auth.uid()) with check (id = auth.uid());
create policy "public reads online hosts" on public.hosts for select using (is_online or user_id = auth.uid());
create policy "owners create host" on public.hosts for insert with check (user_id = auth.uid());
create policy "owners update host" on public.hosts for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "session participants read" on public.vouchers_sessions for select using (
  user_id = auth.uid() or exists(select 1 from public.hosts h where h.id=host_id and h.user_id=auth.uid())
);
create policy "message participants read" on public.messages for select using (sender_id=auth.uid() or receiver_id=auth.uid());
create policy "message participants insert" on public.messages for insert with check (
  sender_id=auth.uid() and exists (
    select 1 from public.vouchers_sessions s join public.hosts h on h.id=s.host_id
    where s.host_id=messages.host_id and s.status='active' and s.expires_at>now()
      and ((sender_id=s.user_id and receiver_id=h.user_id) or (sender_id=h.user_id and receiver_id=s.user_id))
  )
);
create policy "receiver marks read" on public.messages for update using (receiver_id=auth.uid()) with check (receiver_id=auth.uid());
create policy "users create tickets" on public.tickets for insert with check (user_id=auth.uid());
create policy "users read tickets" on public.tickets for select using (user_id=auth.uid() or exists(select 1 from public.users u where u.id=auth.uid() and u.role='admin'));
create policy "admins update tickets" on public.tickets for update using (exists(select 1 from public.users u where u.id=auth.uid() and u.role='admin'));
create policy "users read own transactions" on public.transactions for select using (user_id=auth.uid());
create policy "users create own payment intents" on public.payment_intents for insert with check (user_id=auth.uid());
create policy "users read own payment intents" on public.payment_intents for select using (user_id=auth.uid());

-- API privileges plus column-level restrictions complement RLS.
grant select on public.users, public.hosts, public.vouchers_sessions, public.messages, public.tickets, public.transactions, public.payment_intents to authenticated;
grant insert on public.messages, public.tickets to authenticated;
revoke update on public.users from authenticated;
grant update(name, phone, email) on public.users to authenticated;
revoke insert, update on public.hosts from authenticated;
grant insert(user_id,business_name,latitude,longitude,address,router_mac,router_identity,is_online,voucher_fee,speed_mbps,capacity) on public.hosts to authenticated;
grant update(business_name,latitude,longitude,address,router_mac,router_identity,is_online,voucher_fee,speed_mbps,capacity) on public.hosts to authenticated;
revoke update on public.messages from authenticated;
grant update(read_at) on public.messages to authenticated;
revoke insert, update on public.payment_intents from authenticated;

-- Do not expose balance-changing RPCs to anonymous clients.
revoke all on function public.purchase_voucher(uuid, macaddr, integer, text) from public, anon;
grant execute on function public.purchase_voucher(uuid, macaddr, integer, text) to authenticated, service_role;
revoke all on function public.confirm_paystack_payment(uuid, text, numeric, jsonb) from public, anon, authenticated;
grant execute on function public.confirm_paystack_payment(uuid, text, numeric, jsonb) to service_role;
revoke all on function public.admin_adjust_wallet(uuid, numeric, text) from public, anon;
grant execute on function public.admin_adjust_wallet(uuid, numeric, text) to authenticated, service_role;

-- Supabase Realtime messages (safe to run once; ignore duplicate publication error if rerun).
alter publication supabase_realtime add table public.messages;
