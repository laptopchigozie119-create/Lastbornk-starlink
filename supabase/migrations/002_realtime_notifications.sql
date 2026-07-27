-- Realtime alerts for wallet deposits and mock connection state changes.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'transactions'
  ) then
    alter publication supabase_realtime add table public.transactions;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'vouchers_sessions'
  ) then
    alter publication supabase_realtime add table public.vouchers_sessions;
  end if;
end $$;

-- Connected mock sessions use the existing `used` enum value. Keep host chat
-- available while a customer is connected as well as before connection.
drop policy if exists "message participants insert" on public.messages;
create policy "message participants insert" on public.messages
for insert with check (
  sender_id = auth.uid() and exists (
    select 1
    from public.vouchers_sessions s
    join public.hosts h on h.id = s.host_id
    where s.host_id = messages.host_id
      and s.status in ('active', 'used')
      and s.expires_at > now()
      and (
        (sender_id = s.user_id and receiver_id = h.user_id)
        or (sender_id = h.user_id and receiver_id = s.user_id)
      )
  )
);
