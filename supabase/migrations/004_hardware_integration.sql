-- Physical router configuration and provisioning audit queue.
create type public.router_integration_mode as enum ('radius', 'controller_webhook');
create type public.provision_status as enum ('pending', 'ready', 'delivered', 'failed', 'revoked');

create table public.hardware_configs (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null unique references public.hosts(id) on delete cascade,
  router_type text not null default 'mikrotik' check (router_type in ('mikrotik','openwrt','unifi','other')),
  integration_mode public.router_integration_mode not null default 'radius',
  router_address text,
  controller_url text,
  router_identity text not null,
  api_username text,
  encrypted_secret text,
  enabled boolean not null default false,
  last_seen_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index hardware_configs_host_idx on public.hardware_configs(host_id);

create table public.router_provision_jobs (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.hosts(id) on delete cascade,
  session_id uuid not null unique references public.vouchers_sessions(id) on delete cascade,
  hardware_config_id uuid references public.hardware_configs(id) on delete set null,
  status public.provision_status not null default 'pending',
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index router_jobs_status_idx on public.router_provision_jobs(status,created_at);

alter table public.hardware_configs enable row level security;
alter table public.router_provision_jobs enable row level security;
grant select on public.hardware_configs, public.router_provision_jobs to authenticated;

create policy "host owners read hardware" on public.hardware_configs for select using (
  exists(select 1 from public.hosts h where h.id=host_id and h.user_id=auth.uid())
);
create policy "host owners read jobs" on public.router_provision_jobs for select using (
  exists(select 1 from public.hosts h where h.id=host_id and h.user_id=auth.uid())
);

-- The Express API performs validated writes with the service role. Never grant
-- browser clients access to encrypted_secret or provisioning mutations.
revoke insert, update, delete on public.hardware_configs from authenticated;
revoke insert, update, delete on public.router_provision_jobs from authenticated;
