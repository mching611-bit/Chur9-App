-- Chur9 M3 incident fix: backfill points for task_instances that were
-- already 'completed' before the 0006 scoring trigger was actually
-- installed (e.g. an environment where 0005+0006 got pasted into the SQL
-- Editor together, which rolls back as one transaction and silently
-- leaves neither trigger present — see 0006_points_scoring.sql's header).
-- Those completions never got a chance to fire the trigger and never will
-- on their own, since it only fires on the transition into 'completed'.
--
-- Safe to run on any environment, including ones that never hit the bug —
-- it only touches completed instances with no existing points_ledger row,
-- so it's a no-op wherever scoring was already working. Mirrors
-- award_points_on_task_completion()'s formula exactly.

do $$
declare
  r record;
  v_base_score int;
  v_zero_nag_bonus numeric;
  v_honesty_bonus numeric;
  v_points int;
begin
  for r in
    select ti.id, ti.notification_count, t.difficulty, t.type, t.churless_level, t.user_id
    from public.task_instances ti
    join public.tasks t on t.id = ti.task_id
    where ti.status = 'completed'
      and not exists (
        select 1 from public.points_ledger pl where pl.task_instance_id = ti.id
      )
  loop
    v_base_score := case r.difficulty
      when 'easy' then 20
      when 'medium' then 50
      when 'hard' then 100
    end;

    if r.type = 'recurring' then
      v_points := round(v_base_score * 0.5);
    else
      v_zero_nag_bonus := case when r.notification_count = 0 then v_base_score * 0.2 else 0 end;
      v_honesty_bonus := case when r.churless_level >= 7 then 10 else 0 end;
      v_points := round(greatest(
        v_base_score - (r.notification_count * 5) + v_zero_nag_bonus + v_honesty_bonus,
        v_base_score * 0.3
      ));
    end if;

    insert into public.points_ledger (user_id, task_instance_id, points_awarded, base_score)
    values (r.user_id, r.id, v_points, v_base_score)
    on conflict (task_instance_id) do nothing;
  end loop;
end $$;
