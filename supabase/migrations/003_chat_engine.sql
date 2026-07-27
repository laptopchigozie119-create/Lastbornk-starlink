-- Lastbornk rich chat engine.
-- Required once for text, image, voice/audio, video and file messages.

-- Mock testing can use the same Supabase identity as customer and host. Remove
-- the original sender <> receiver check without depending on its generated name.
do $$
declare constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.messages'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%sender_id%receiver_id%'
  loop
    execute format('alter table public.messages drop constraint %I', constraint_name);
  end loop;
end $$;

-- Replace the original text-only validation with rich-message validation.
do $$
declare constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.messages'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%char_length%text%'
  loop
    execute format('alter table public.messages drop constraint %I', constraint_name);
  end loop;
end $$;

alter table public.messages alter column text drop not null;
alter table public.messages add column if not exists message_type text not null default 'text';
alter table public.messages add column if not exists author_role text not null default 'customer';
alter table public.messages add column if not exists attachment_path text;
alter table public.messages add column if not exists attachment_name text;
alter table public.messages add column if not exists attachment_mime text;
alter table public.messages add column if not exists attachment_size bigint;

alter table public.messages drop constraint if exists messages_rich_content_check;
alter table public.messages add constraint messages_rich_content_check check (
  (text is not null and char_length(btrim(text)) between 1 and 2000)
  or attachment_path is not null
);
alter table public.messages drop constraint if exists messages_type_check;
alter table public.messages add constraint messages_type_check check (
  message_type in ('text','image','audio','video','file')
);
alter table public.messages drop constraint if exists messages_author_role_check;
alter table public.messages add constraint messages_author_role_check check (
  author_role in ('customer','host')
);
alter table public.messages drop constraint if exists messages_attachment_size_check;
alter table public.messages add constraint messages_attachment_size_check check (
  attachment_size is null or attachment_size between 1 and 12582912
);

create index if not exists messages_session_time_idx on public.messages(session_id,timestamp);

-- The API uses the service role for writes after explicitly validating the
-- voucher participant pair. Reads remain protected by RLS and the API.
drop policy if exists "message participants insert" on public.messages;
create policy "message participants insert" on public.messages
for insert with check (
  sender_id = auth.uid() and exists (
    select 1
    from public.vouchers_sessions s
    join public.hosts h on h.id = s.host_id
    where s.id = messages.session_id
      and s.host_id = messages.host_id
      and s.status in ('active','used','expired')
      and (
        (sender_id = s.user_id and receiver_id = h.user_id)
        or (sender_id = h.user_id and receiver_id = s.user_id)
      )
  )
);

-- Keep Realtime enabled safely when this migration is rerun.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
