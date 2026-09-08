-- Chur9 M2 follow-up: pre-due "heads-up" reminder — a single, calm,
-- non-escalating reminder a fixed 30 minutes before a task's due time,
-- deliberately kept separate from the post-due escalation engine (uses
-- the same task_reminder notification category client-side, but doesn't
-- touch notification_count/consecutive_ignored, and quiet hours suppress
-- it outright rather than rescheduling it). See
-- supabase/functions/notification-scheduler/index.ts (sweepHeadsUpReminders)
-- and supabase/README.md.

create type public.notification_kind as enum ('reminder', 'heads_up');

-- Existing rows predate this feature entirely, so they're all the
-- escalating kind; backfill via a default, then drop it so every future
-- insert has to say which kind it is.
alter table public.notifications
  add column kind public.notification_kind not null default 'reminder';
alter table public.notifications
  alter column kind drop default;

alter table public.users
  add column heads_up_enabled boolean not null default true;

alter table public.task_instances
  add column heads_up_sent boolean not null default false;
