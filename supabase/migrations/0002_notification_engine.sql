-- Chur9 M2: notification engine schema.
-- Populates the `notifications` shell from M1 and extends `users` per the
-- M2 build brief. Also adds scheduling state to `task_instances` — the
-- brief's data model section doesn't mention task_instances, but the
-- scheduler needs somewhere fast to find "what's due next" without
-- rescanning all of `notifications`, so `next_notification_at` /
-- `notification_count` / `consecutive_ignored` live there. See
-- supabase/README.md for the full rationale and the ops setup this
-- migration assumes (pg_cron + pg_net, Edge Function secrets).

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.notification_channel as enum ('push', 'email');
create type public.notification_action as enum ('done', 'snooze_30', 'snooze_2hr', 'none');

-- ---------------------------------------------------------------------------
-- notifications: populate the M1 shell
-- ---------------------------------------------------------------------------

alter table public.notifications
  add column channel public.notification_channel not null default 'push',
  add column action_taken public.notification_action,
  add column responded_at timestamptz;

-- M1 left this nullable for the shell; every row the engine writes has one.
-- Defensive backfill in case any shell rows exist before tightening the
-- constraint (the table is expected to be empty at this point).
update public.notifications set sent_at = created_at where sent_at is null;

alter table public.notifications
  alter column sent_at set not null;

alter table public.notifications
  alter column channel drop default;

create index notifications_task_instance_id_idx on public.notifications (task_instance_id);
create index notifications_pending_idx on public.notifications (task_instance_id, sent_at)
  where action_taken is null;

-- ---------------------------------------------------------------------------
-- users: quiet hours, email opt-in, push token (brief's exact additions),
-- plus timezone — quiet_hours_start/end are meaningless without one, since
-- the scheduler evaluates them against wall-clock time for the user.
-- Assumption flagged in supabase/README.md; defaults to UTC.
-- ---------------------------------------------------------------------------

alter table public.users
  add column quiet_hours_start time,
  add column quiet_hours_end time,
  add column email_opt_in boolean not null default false,
  add column push_token text,
  add column timezone text not null default 'UTC';

-- ---------------------------------------------------------------------------
-- task_instances: scheduler state
-- ---------------------------------------------------------------------------

alter table public.task_instances
  add column next_notification_at timestamptz,
  add column notification_count int not null default 0,
  add column consecutive_ignored int not null default 0;

create index task_instances_next_notification_idx on public.task_instances (next_notification_at)
  where status = 'active';

-- Seed next_notification_at = due_at for existing active instances so the
-- scheduler has somewhere to start; new instances get this via the trigger
-- below.
update public.task_instances
set next_notification_at = due_at
where status = 'active' and next_notification_at is null;

create function public.set_initial_notification_time()
returns trigger
language plpgsql
as $$
begin
  if new.next_notification_at is null then
    new.next_notification_at := new.due_at;
  end if;
  return new;
end;
$$;

create trigger task_instances_set_initial_notification_time
  before insert on public.task_instances
  for each row execute function public.set_initial_notification_time();

-- ---------------------------------------------------------------------------
-- RLS: existing "notifications_all_own" / task_instances policies already
-- cover the new columns (same-owner, no per-column grants in this schema).
-- The scheduler Edge Function runs with the service role key and bypasses
-- RLS entirely, which is required since it writes/reads across all users.
-- ---------------------------------------------------------------------------
