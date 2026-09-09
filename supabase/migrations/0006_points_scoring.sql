-- Chur9 M3: points/rank scoring engine.
--
-- Computed server-side (trigger on task_instances, not client code) per the
-- build brief: notification_count already lives in the DB and is the input
-- to the nag penalty, so points need the same tamper-resistance rather than
-- trusting whatever the client posts.

-- ---------------------------------------------------------------------------
-- tasks: let 'calendar' (0005) share custom's recurrence_rule shape
-- ---------------------------------------------------------------------------

alter table public.tasks drop constraint tasks_recurrence_rule_matches_type;

alter table public.tasks add constraint tasks_recurrence_rule_matches_type check (
  (type = 'recurring' and recurrence_rule is not null)
  or (type in ('custom', 'calendar') and recurrence_rule is null)
);

-- ---------------------------------------------------------------------------
-- points_ledger: populate the M1 shell per the M3 data model
-- ---------------------------------------------------------------------------

alter table public.points_ledger rename column points to points_awarded;

alter table public.points_ledger add column base_score int not null default 0;
alter table public.points_ledger alter column base_score drop default;

-- One ledger row per completed instance. Also closes off a reopen ->
-- re-complete loop (task_instances.status can go completed -> active via
-- reopenTaskInstance) from farming duplicate awards for the same
-- occurrence — the trigger below relies on this via ON CONFLICT DO NOTHING.
alter table public.points_ledger
  add constraint points_ledger_task_instance_id_key unique (task_instance_id);

-- ---------------------------------------------------------------------------
-- Rank thresholds (fixed table, from the M3 build brief)
-- ---------------------------------------------------------------------------

create table public.rank_thresholds (
  rank text primary key,
  min_points int not null unique
);

alter table public.rank_thresholds enable row level security;

create policy "rank_thresholds_select_all" on public.rank_thresholds
  for select using (true);

insert into public.rank_thresholds (rank, min_points) values
  ('Intern', 0),
  ('Analyst', 500),
  ('Associate', 1500),
  ('Senior Associate', 2500),
  ('Vice President', 4000),
  ('Senior Vice President', 7000),
  ('Director', 12000),
  ('Managing Director', 25000),
  ('Partner', 60000);

create function public.rank_for_points(p_points int)
returns text
language sql
stable
as $$
  select rank from public.rank_thresholds
  where min_points <= p_points
  order by min_points desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Scoring: award points when a task_instance flips to 'completed'.
-- Difficulty base scores and the nag-penalty/bonus formula are exactly the
-- M3 build brief's.
-- ---------------------------------------------------------------------------

create function public.award_points_on_task_completion()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_base_score int;
  v_zero_nag_bonus numeric := 0;
  v_honesty_bonus numeric := 0;
  v_points int;
begin
  if new.status is distinct from 'completed' or old.status = 'completed' then
    return new;
  end if;

  select * into v_task from public.tasks where id = new.task_id;

  v_base_score := case v_task.difficulty
    when 'easy' then 20
    when 'medium' then 50
    when 'hard' then 100
  end;

  if v_task.type = 'recurring' then
    -- Flat, reduced value for v1 recurring tasks — no nag penalty/bonus
    -- math, per the brief (keeps recurring meaningfully lower-value than
    -- custom without building streak tracking yet).
    v_points := round(v_base_score * 0.5);
  else
    -- 'custom' and 'calendar' (the latter not reachable via the app yet —
    -- see 0005_calendar_task_type.sql) share the full formula.
    if new.notification_count = 0 then
      v_zero_nag_bonus := v_base_score * 0.2;
    end if;
    if v_task.churless_level >= 7 then
      v_honesty_bonus := 10;
    end if;

    v_points := round(greatest(
      v_base_score - (new.notification_count * 5) + v_zero_nag_bonus + v_honesty_bonus,
      v_base_score * 0.3
    ));
  end if;

  insert into public.points_ledger (user_id, task_instance_id, points_awarded, base_score)
  values (v_task.user_id, new.id, v_points, v_base_score)
  on conflict (task_instance_id) do nothing;

  return new;
end;
$$;

create trigger task_instances_award_points
  after update on public.task_instances
  for each row execute function public.award_points_on_task_completion();

-- ---------------------------------------------------------------------------
-- users: keep total_points/rank in sync with the ledger
-- ---------------------------------------------------------------------------

create function public.apply_points_ledger_entry()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_new_total int;
begin
  update public.users
  set total_points = total_points + new.points_awarded
  where id = new.user_id
  returning total_points into v_new_total;

  update public.users
  set rank = public.rank_for_points(v_new_total)
  where id = new.user_id;

  return new;
end;
$$;

create trigger points_ledger_apply_to_user
  after insert on public.points_ledger
  for each row execute function public.apply_points_ledger_entry();
