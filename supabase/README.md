# Chur9 Supabase setup

## Migrations

Run in order against your Supabase project (Dashboard → SQL Editor, or
`supabase db push` with the CLI):

1. `migrations/0001_init_schema.sql` — M1: users/tasks/task_instances +
   scaffolding for calendar_events/notifications/points_ledger.
2. `migrations/0002_notification_engine.sql` — M2: populates `notifications`,
   adds `quiet_hours_start`/`quiet_hours_end`/`email_opt_in`/`push_token` to
   `users`, plus scheduling state (`next_notification_at`,
   `notification_count`, `consecutive_ignored`) to `task_instances`.

**One addition beyond the M2 brief:** `users.timezone` (default `'UTC'`).
Quiet hours are wall-clock local time, and there was no timezone column to
evaluate them against — the app now writes the device's IANA timezone
(`Intl.DateTimeFormat().resolvedOptions().timeZone`) to this column on every
sign-in. Flagging in case you'd rather handle timezone differently (e.g. a
fixed org timezone, or asking the user explicitly).

## Notification engine (M2)

### How it fits together

- `supabase/functions/_shared/scheduling.ts` — pure, platform-agnostic
  scheduling logic (churless-level interval randomization, quiet-hours
  check/reschedule, send-time-learning candidate weighting). No Deno or
  Supabase imports; this is the part of the brief that "shouldn't care which
  push service it's calling."
- `supabase/functions/_shared/expoPush.ts` — sends via the **Expo Push API**
  (`https://exp.host/--/api/v2/push/send`), which fans out to FCM (Android)
  and APNs (iOS) from one call. This is what makes the engine
  platform-agnostic in practice, and matches the brief's Android-first,
  Expo-based build order.
- `supabase/functions/_shared/email.ts` — opt-in email escalation via
  **SendGrid**. The brief says "the SendGrid/Postmark account from M0" — M0
  isn't in this repo, so I implemented SendGrid; swap the fetch call if the
  account is actually Postmark.
- `supabase/functions/notification-scheduler/index.ts` — the periodic sweep:
  marks unanswered nags as timed out (escalation), sends due nags, computes
  each task instance's next nag time.

### Deploying the function

```
supabase functions deploy notification-scheduler
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by
Supabase into every Edge Function — nothing to set there. You do need to set:

```
supabase secrets set CRON_SECRET=<random string>
supabase secrets set EXPO_ACCESS_TOKEN=<optional, only if you enable Expo's enhanced push security>
supabase secrets set SENDGRID_API_KEY=<from M0>
supabase secrets set SENDGRID_FROM_EMAIL=<verified sender>
```

`CRON_SECRET` just stops the public function URL from being invoked by
anyone who finds it; the scheduler checks it against an `x-cron-secret`
header.

### Wiring the schedule

The function expects to be invoked every ~5 minutes. Two ways to do that;
pick one:

**Option A — pg_cron + pg_net (portable, lives in SQL):**

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'chur9-notification-sweep',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://<project-ref>.functions.supabase.co/notification-scheduler',
    headers := jsonb_build_object('x-cron-secret', '<same value as CRON_SECRET>'),
    body := '{}'::jsonb
  );
  $$
);
```

**Option B — Supabase Dashboard → Edge Functions → notification-scheduler →
Cron**, if your plan supports it. Functionally equivalent; no SQL to
maintain, but it's dashboard-only state rather than something checked into
the repo.

## Client (Expo) setup

Already wired in code (`src/lib/pushNotifications.ts`, `App.tsx`,
`src/navigation/RootNavigator.tsx`, Notification settings screen). What's
still needed from your side:

1. **`eas init`** (needs an Expo account) — links this project to EAS and
   writes `extra.eas.projectId` into `app.json`. Without it,
   `registerForPushNotificationsAsync` logs a warning and no-ops instead of
   crashing.
2. **Firebase project + FCM V1 credentials** — create a free Firebase
   project, generate a service account key (Project Settings → Service
   Accounts → Generate new private key), then run `eas credentials` and
   upload it under Android → Push Notifications. This is separate from
   `google-services.json` — you don't need that file for push-only usage,
   only if you want other Firebase services.
3. **A development build for real testing.** Expo Go on Android **stopped
   supporting remote push notifications as of SDK 53** — this repo is on
   SDK 57, so Expo Go cannot receive the pushes this engine sends, contrary
   to the brief's plan to verify on Android via Expo Go. Build a dev client
   instead:
   ```
   eas build --profile development --platform android
   ```
   (or `npx expo run:android` if you'd rather build locally with Android
   Studio installed). Expo Go is still fine for exercising permission
   prompts and the notification category/action-button UI via a local test
   notification (`Notifications.scheduleNotificationAsync`) — just not for
   an actual remote push round-trip.
4. **SendGrid API key + verified sender** (see above) for the email
   escalation channel.

## Design notes / assumptions worth double-checking

- **Escalation threshold**: 20 minutes (`IGNORED_THRESHOLD_MINUTES` in
  `notification-scheduler/index.ts`), the middle of the brief's suggested
  15–30 min range. Easy one-line change to tune.
- **Escalation behavior**: each consecutive ignored nag shortens the next
  interval (down to a 10-minute floor) *and*, from the first ignore onward,
  sends an email alongside the push if the user has opted in. The brief
  offered these as alternatives ("resend sooner **or** bump intensity") — I
  did both, since neither alone fully matches "hard to ignore."
- **`action_taken = 'none'`**: the brief's enum includes this value but
  doesn't fully spec when it's set. I use it as the escalation sweep's
  timeout marker (no response within the threshold) — `responded_at` stays
  null in that case since the user never actually responded, only the
  timeout was detected.
- **Send-time learning**: computed live in the scheduler (average response
  minutes per hour-of-day bucket, min 3 samples to trust a bucket) rather
  than a stored aggregate table, per the brief's "don't over-engineer"
  steer. Revisit if the per-run query cost becomes a problem at scale.
- **iOS action buttons**: registered the same `task_reminder` category on
  both platforms, but background (app-not-running) handling of a tapped
  action is Android-only for now (`expo-task-manager` background
  notification task). iOS can still handle actions via the
  foreground/cold-start listener paths, but the "handle it without fully
  opening the app" behavior Android gets natively isn't wired for iOS — the
  brief already scopes iOS verification as blocked on the Apple Developer
  account anyway.
