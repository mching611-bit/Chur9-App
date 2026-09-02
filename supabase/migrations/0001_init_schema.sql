-- Chur9 M1: data foundation (users, tasks, task_instances) + scaffolding for
-- calendar_events / notifications / points_ledger (used starting M2+).
-- Safe to run once against a fresh Supabase project (Database > SQL Editor,
-- or `supabase db push` if using the CLI). See supabase/README.md for setup.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.task_type as enum ('custom', 'recurring');
create type public.task_difficulty as enum ('easy', 'medium', 'hard');
create type public.task_instance_status as enum ('active', 'completed', 'overdue');

-- ---------------------------------------------------------------------------
-- users (public profile row, 1:1 with auth.users)
-- ---------------------------------------------------------------------------

create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  default_churless_level int not null default 3,
  total_points int not null default 0,
  rank text not null default 'Intern'
);

alter table public.users enable row level security;

create policy "users_select_own" on public.users
  for select using (auth.uid() = id);

create policy "users_update_own" on public.users
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- New auth.users rows automatically get a matching public.users profile row.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- tasks (the template/definition)
-- ---------------------------------------------------------------------------

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  title text not null,
  type public.task_type not null,
  difficulty public.task_difficulty not null default 'medium',
  churless_level int not null default 3,
  recurrence_rule text,
  created_at timestamptz not null default now(),
  constraint tasks_churless_level_range check (churless_level between 1 and 10),
  constraint tasks_recurrence_rule_matches_type check (
    (type = 'recurring' and recurrence_rule is not null)
    or (type = 'custom' and recurrence_rule is null)
  )
);

alter table public.tasks enable row level security;

create index tasks_user_id_idx on public.tasks (user_id);

create policy "tasks_all_own" on public.tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- task_instances (each actual occurrence of a task)
-- ---------------------------------------------------------------------------

create table public.task_instances (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  due_at timestamptz not null,
  completed_at timestamptz,
  status public.task_instance_status not null default 'active'
);

alter table public.task_instances enable row level security;

create index task_instances_task_id_idx on public.task_instances (task_id);
create index task_instances_status_idx on public.task_instances (status);

create policy "task_instances_all_own" on public.task_instances
  for all using (
    exists (
      select 1 from public.tasks t
      where t.id = task_instances.task_id and t.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.tasks t
      where t.id = task_instances.task_id and t.user_id = auth.uid()
    )
  );

-- Lazily flips the caller's own past-due active instances to 'overdue'.
-- Called by the app when the task list loads (no cron/scheduler needed for M1).
create function public.mark_overdue_task_instances()
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
    and ti.due_at < now();
$$;

-- ---------------------------------------------------------------------------
-- Scaffolding for later milestones. No app logic depends on these in M1;
-- they exist now so task_instances can attach to them without a schema
-- migration later.
-- ---------------------------------------------------------------------------

create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  task_instance_id uuid references public.task_instances (id) on delete cascade,
  external_event_id text,
  created_at timestamptz not null default now()
);

alter table public.calendar_events enable row level security;

create policy "calendar_events_all_own" on public.calendar_events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  task_instance_id uuid references public.task_instances (id) on delete cascade,
  scheduled_for timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.notifications enable row level security;

create policy "notifications_all_own" on public.notifications
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table public.points_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  task_instance_id uuid references public.task_instances (id) on delete cascade,
  points int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.points_ledger enable row level security;

create policy "points_ledger_all_own" on public.points_ledger
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
