# Chur9

A gamified task manager where a fixed, unranked "Management" nags you via push
notifications until tasks get done. Complete tasks to climb a corporate rank
ladder (Intern → Partner).

M1 (data foundation/task CRUD), M2 (push notifications, quiet hours,
escalation), and M3 (points/rank scoring) are built. Calendar sync and the
sign-off interaction are not yet — the schema is shaped so they can attach
later without a migration (see `supabase/migrations/`).

## Stack

- **Frontend:** React Native (Expo, TypeScript)
- **Backend:** Supabase (Postgres + built-in Auth)
- **Navigation:** React Navigation (native-stack)

## Setup

### 1. Create a Supabase project

Create a free-tier project at [supabase.com](https://supabase.com).

### 2. Apply the schema

In the Supabase dashboard, open **SQL Editor** and run the contents of
[`supabase/migrations/0001_init_schema.sql`](supabase/migrations/0001_init_schema.sql).
(If you use the Supabase CLI instead: `supabase db push` from the project
root, with this repo linked to your project.)

This creates:

- `users` — public profile row (1:1 with `auth.users`, auto-created on
  sign-up via trigger)
- `tasks` — the task template/definition (`custom` or `recurring`)
- `task_instances` — each actual occurrence of a task, with `due_at` /
  `completed_at` / `status`
- `calendar_events`, `notifications`, `points_ledger` — empty table shells
  for later milestones; no app logic touches them yet
- Row Level Security policies so each user can only see/edit their own rows
- `mark_overdue_task_instances()` — a Postgres function the app calls on
  every task-list load to flip past-due active instances to `overdue`

Email/password auth works out of the box with Supabase Auth defaults. If
your project has "Confirm email" enabled, new users need to confirm via
email before they can sign in.

### 3. Configure the app

```bash
cp .env.example .env
```

Fill in `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` from
your Supabase project's **Settings → API** page.

### 4. Install and run

```bash
npm install
npm run web       # or: npm run ios / npm run android
```

## Project structure

```
supabase/migrations/   SQL schema (source of truth for the DB)
src/lib/supabase.ts    Supabase client (session persisted via AsyncStorage)
src/types/database.ts  Row types mirroring the schema
src/contexts/          Auth session state
src/api/tasks.ts        Task/task_instance CRUD + recurrence rollover
src/api/profile.ts      Reads total_points/rank for the Profile screen
src/utils/recurrence.ts Next-due-date calculation for recurring tasks
src/utils/ranks.ts      Rank ladder + progress-to-next-rank (mirrors rank_thresholds)
src/lib/toast.ts        Cross-cutting "+N pts" toast bus
src/navigation/         Auth stack vs. app stack, switched on session
src/screens/            Sign in/up, task list, task form, notification settings, profile
src/components/         Shared UI (buttons, inputs, task card, toast)
src/theme/              Palette and font choices
```

## M1 scope

- Sign up / log in (Supabase Auth)
- Create, edit, delete tasks — `custom` (one-off) and `recurring`
- Task list with Active / Overdue / Completed tabs
- Basic create/edit task screen

A custom task gets exactly one `task_instance` on creation. A recurring
task also starts with one instance; completing it generates the next single
upcoming instance based on `recurrence_rule` (`daily`, `weekdays`, or
`weekly` — see `src/utils/recurrence.ts`). Pre-generating a longer series
is deferred until the M2 notification engine needs to look further ahead.

Not in M1: push notifications, quiet hours, points/rank calculation,
calendar sync, the sign-off/signature interaction.

## M3 scope

- Points awarded server-side (Postgres trigger, not the client) when a task
  is marked complete, per the difficulty base score / nag-penalty / zero-nag
  and honesty bonuses / floor formula — see "Points/rank scoring (M3)" in
  `supabase/README.md`.
- `users.total_points` and `users.rank` kept in sync via a second trigger,
  rank derived from the fixed `rank_thresholds` table.
- New Profile screen (`src/screens/ProfileScreen.tsx`, linked from the task
  list header) showing current rank, total points, and progress to the next
  rank.
- "+N pts" toast on completion, from both the "Mark complete" button and the
  notification's Done action.

Not in M3: streak tracking for recurring tasks (flat half-value score for
v1 instead), calendar-sourced task scoring (schema-ready via the `calendar`
task type, gated on the M4 opt-in flow), rank-up celebration/animation.
