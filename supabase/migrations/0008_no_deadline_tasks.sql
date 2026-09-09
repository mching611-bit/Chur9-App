-- Chur9 M3.5 Part 2: no-deadline task type.
--
-- Custom (one-off) tasks only — recurring tasks always have a due time and
-- are unaffected. A no-deadline task has no due_at at all: nagging starts
-- immediately from creation time (via set_initial_notification_time below)
-- using the same Churless-level interval table as everything else, never
-- shows as 'overdue' (mark_overdue_task_instances skips it), and escalates
-- through the exact same M2 code path in
-- supabase/functions/notification-scheduler/index.ts — that logic only
-- keys off next_notification_at/notification_count/consecutive_ignored,
-- none of which care whether due_at is null, so no scheduler changes are
-- needed here at all.

alter table public.tasks
  add column has_deadline boolean not null default true;

-- Only a custom task can opt out of having a deadline; recurring (and the
-- not-yet-reachable calendar type) stay due-time-based.
alter table public.tasks
  add constraint tasks_has_deadline_only_for_custom check (
    has_deadline or type = 'custom'
  );

alter table public.task_instances
  alter column due_at drop not null;

-- New instance with no due_at (a no-deadline task) starts nagging from
-- creation time instead of due time.
create or replace function public.set_initial_notification_time()
returns trigger
language plpgsql
as $$
begin
  if new.next_notification_at is null then
    new.next_notification_at := coalesce(new.due_at, now());
  end if;
  return new;
end;
$$;

-- due_at is nullable now (no-deadline task_instances) — `due_at < now()`
-- already evaluates to null (excluded by WHERE) for those rows, but say so
-- explicitly per the brief rather than relying on that.
create or replace function public.mark_overdue_task_instances()
returns void
language sql
security invoker
as $$
  update public.task_instances ti
  set status = 'overdue'
  from public.tasks t
  where ti.task_id = t.id
    and t.user_id = auth.uid()
    and ti.status = 'active'
    and ti.due_at is not null
    and ti.due_at < now();
$$;
