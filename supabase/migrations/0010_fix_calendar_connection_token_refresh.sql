-- Fixes a bug in upsert_calendar_connection (0009_calendar_connections.sql):
-- every token refresh (p_refresh_token = null, since Google only reissues a
-- refresh_token on the original consent, not on every access-token refresh)
-- failed with "null value in column refresh_token ... violates not-null
-- constraint" — confirmed via Edge Function logs on calendar-sync's
-- refreshAndPersist call.
--
-- Root cause: `insert ... values (..., p_refresh_token, ...) on conflict
-- (...) do update set refresh_token = coalesce(p_refresh_token, ...)`
-- doesn't work the way it looks like it should. Postgres validates NOT
-- NULL constraints on the proposed row during the speculative insert
-- attempt itself, *before* a conflict is detected and the statement
-- decides to run the DO UPDATE branch instead — so a null in the VALUES
-- tuple trips the not-null constraint every time, even for an update-only
-- call, regardless of what the UPDATE SET clause would have coalesced it
-- to. The `coalesce(...)` in the old version never got a chance to run.
--
-- Fix: replace the single INSERT ... ON CONFLICT statement with an
-- explicit UPDATE first, INSERT only if no row existed — the classic
-- pre-ON-CONFLICT upsert idiom. The UPDATE path never constructs a row
-- with a null refresh_token (it SETs a coalesced value against an
-- existing, already-non-null column), so it never touches the NOT NULL
-- constraint at all. The INSERT path (a genuinely new connection) still
-- requires a real p_refresh_token and fails loudly with a clear message if
-- one wasn't provided, same intent as before. The insert is wrapped for
-- unique_violation and retried as an update to stay race-safe against a
-- rare concurrent insert (e.g. two overlapping calendar-sync runs) landing
-- between this call's UPDATE and INSERT.

create or replace function public.upsert_calendar_connection(
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
  loop
    update public.calendar_connections
    set access_token = p_access_token,
        refresh_token = coalesce(p_refresh_token, refresh_token),
        expires_at = p_expires_at,
        updated_at = now()
    where user_id = p_user_id and provider = p_provider;

    if found then
      return;
    end if;

    if p_refresh_token is null then
      raise exception
        'upsert_calendar_connection: refresh_token required for a new connection (user_id=%, provider=%)',
        p_user_id, p_provider;
    end if;

    begin
      insert into public.calendar_connections (user_id, provider, access_token, refresh_token, expires_at)
      values (p_user_id, p_provider, p_access_token, p_refresh_token, p_expires_at);
      return;
    exception when unique_violation then
      -- Someone else inserted this user+provider's row between our UPDATE
      -- and INSERT — loop back and UPDATE the row they just created.
    end;
  end loop;
end;
$$;

-- CREATE OR REPLACE keeps the function's existing grants, but reissuing
-- these is harmless and keeps this migration self-contained/safe to run
-- against a fresh environment on its own.
revoke execute on function public.upsert_calendar_connection(uuid, public.calendar_provider, text, text, timestamptz) from public;
grant execute on function public.upsert_calendar_connection(uuid, public.calendar_provider, text, text, timestamptz) to service_role;
