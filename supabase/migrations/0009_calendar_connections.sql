-- Chur9 M4: calendar suppression (Google, Outlook deferred).
--
-- Two new tables, both locked down to service-role-only access via RLS with
-- no client policies — access_token/refresh_token are meaningfully more
-- sensitive than anything else this app stores (e.g. users.push_token), and
-- busy_blocks is a pure backend cache the brief explicitly says never
-- surfaces in the UI. The client only ever touches this data through the
-- security-definer functions below, which take auth.uid() as the source of
-- truth for "whose row is this" rather than trusting a client-supplied user
-- id. See supabase/README.md "Calendar suppression (M4)" for the full
-- design writeup, including why this is access-control rather than
-- column-level encryption-at-rest.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- 'outlook' is unused this milestone (deferred — see build brief) but
-- included now so adding it later is a data migration, not a schema change.
create type public.calendar_provider as enum ('google', 'outlook');

-- ---------------------------------------------------------------------------
-- calendar_connections
-- ---------------------------------------------------------------------------

create table public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  provider public.calendar_provider not null,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

alter table public.calendar_connections enable row level security;
-- Deliberately no policies for anon/authenticated — only service_role
-- (which bypasses RLS) and the security-definer functions below can touch
-- this table. A client never reads or writes it directly.

-- ---------------------------------------------------------------------------
-- busy_blocks — cache only, safe to fully rebuild on each sync. No
-- provider column: the notification scheduler only cares whether *any*
-- connected provider reports the user busy right now, already merged by
-- the sync job (see calendar-sync/index.ts).
-- ---------------------------------------------------------------------------

create table public.busy_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  start_time timestamptz not null,
  end_time timestamptz not null,
  synced_at timestamptz not null default now()
);

alter table public.busy_blocks enable row level security;
-- Same reasoning as calendar_connections: never shown in the app UI per the
-- build brief, so there's no client read path to support. Only the sync job
-- (service_role) and the notification scheduler (service_role) touch it.

create index busy_blocks_user_window_idx on public.busy_blocks (user_id, start_time, end_time);

-- ---------------------------------------------------------------------------
-- Client-facing access: security-definer functions keyed off auth.uid(),
-- never a client-supplied user id. This is the entire read/write surface an
-- authenticated user has for calendar connections.
-- ---------------------------------------------------------------------------

-- Status only — provider + timestamps, never the tokens themselves. Powers
-- the "Connected" / "Not connected" state in Notification Settings.
create function public.get_calendar_connections()
returns table (provider public.calendar_provider, connected_at timestamptz, expires_at timestamptz)
language sql
security definer set search_path = public
stable
as $$
  select provider, created_at, expires_at
  from public.calendar_connections
  where user_id = auth.uid();
$$;

grant execute on function public.get_calendar_connections() to authenticated;

create function public.disconnect_calendar_connection(p_provider public.calendar_provider)
returns void
language sql
security definer set search_path = public
as $$
  delete from public.calendar_connections
  where user_id = auth.uid() and provider = p_provider;
$$;

grant execute on function public.disconnect_calendar_connection(public.calendar_provider) to authenticated;

-- ---------------------------------------------------------------------------
-- Service-role-only functions: called from the OAuth callback and the sync
-- job, never from the client. Explicit revoke+grant since Postgres makes
-- new functions PUBLIC-executable by default.
-- ---------------------------------------------------------------------------

-- Upserts one connection's tokens. p_refresh_token may be null on a
-- token-refresh call (Google doesn't reissue a refresh_token on every
-- refresh) — in that case the existing stored refresh_token is kept. On a
-- brand new connection p_refresh_token must be provided; a null there is a
-- caller bug and correctly fails the not-null constraint rather than
-- silently storing an empty secret.
create function public.upsert_calendar_connection(
  p_user_id uuid,
  p_provider public.calendar_provider,
  p_access_token text,
  p_refresh_token text,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.calendar_connections (user_id, provider, access_token, refresh_token, expires_at)
  values (p_user_id, p_provider, p_access_token, p_refresh_token, p_expires_at)
  on conflict (user_id, provider) do update
  set access_token = excluded.access_token,
      refresh_token = coalesce(p_refresh_token, public.calendar_connections.refresh_token),
      expires_at = excluded.expires_at,
      updated_at = now();
end;
$$;

revoke execute on function public.upsert_calendar_connection(uuid, public.calendar_provider, text, text, timestamptz) from public;
grant execute on function public.upsert_calendar_connection(uuid, public.calendar_provider, text, text, timestamptz) to service_role;

-- Fully replaces a user's busy_blocks in one transaction (delete + insert)
-- so the scheduler never sees a window where the cache is briefly empty
-- mid-sync.
create function public.replace_busy_blocks(p_user_id uuid, p_blocks jsonb)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  delete from public.busy_blocks where user_id = p_user_id;
  insert into public.busy_blocks (user_id, start_time, end_time, synced_at)
  select p_user_id, (b ->> 'start_time')::timestamptz, (b ->> 'end_time')::timestamptz, now()
  from jsonb_array_elements(p_blocks) as b;
end;
$$;

revoke execute on function public.replace_busy_blocks(uuid, jsonb) from public;
grant execute on function public.replace_busy_blocks(uuid, jsonb) to service_role;
