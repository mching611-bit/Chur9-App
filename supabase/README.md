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
3. `migrations/0003_push_receipts.sql` — adds `expo_ticket_id`/
   `receipt_checked_at`/`expo_receipt_error` to `notifications` for
   delivery-receipt checking (see "Push delivery receipts" below).
4. `migrations/0004_heads_up_reminder.sql` — M2 follow-up: adds
   `notifications.kind` ('reminder' | 'heads_up'), `users.heads_up_enabled`,
   `task_instances.heads_up_sent` for the pre-due heads-up reminder (see
   "Heads-up reminder" below).

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
  **Postmark** (the M0 account this project uses).
- `supabase/functions/notification-scheduler/index.ts` — the periodic sweep,
  four passes each run: marks unanswered nags as timed out (escalation),
  sends due nags and computes each task instance's next nag time, sends the
  pre-due heads-up reminder, and checks delivery receipts for tickets from a
  prior run.

### Heads-up reminder

A single, calm reminder `HEADS_UP_LEAD_MINUTES` (30) before a task's due
time — separate from the Churless-level escalation system entirely:
`sweepHeadsUpReminders` never touches `notification_count` or
`consecutive_ignored`, and `sweepEscalations` explicitly excludes
`kind = 'heads_up'` rows, so an unanswered heads-up just sits there, no
consequence. `task_instances.heads_up_sent` flips to `true` whether it
actually sent or was suppressed by quiet hours (checked against the ideal
30-minutes-before instant itself, not whatever moment the cron sweep
happens to run at — quiet hours here means "skip this occurrence
entirely," not "reschedule," since a heads-up arriving after the task is
already due defeats the point). Toggle is per-user
(`users.heads_up_enabled`, default on), not per-task.

Because `notification_count` stays untouched, a task finished via this
reminder (before due, zero post-due nags) is indistinguishable — from the
scheduler's own bookkeeping — from a task nobody ever had to nag about at
all. That's deliberate: it's what should make a future points system's
"zero-nag bonus" apply correctly to a heads-up completion without that
logic needing to know this reminder exists.

### Deploying the function

```
supabase functions deploy notification-scheduler --no-verify-jwt
```

`--no-verify-jwt` matters: Supabase's platform gateway requires a valid
Authorization JWT on every Edge Function call by default, which a cron
trigger (no logged-in user) can't supply. This function isn't
user-invoked — it authenticates the caller itself via `CRON_SECRET` — so
skipping the platform's JWT check and relying on that header is simpler
than smuggling a service-role key into a cron job config that isn't
checked into the repo either way.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by
Supabase into every Edge Function — nothing to set there. You do need to set:

```
supabase secrets set CRON_SECRET=<random string>
supabase secrets set EXPO_ACCESS_TOKEN=<optional, only if you enable Expo's enhanced push security>
supabase secrets set POSTMARK_SERVER_TOKEN=<Postmark Server API Token>
supabase secrets set POSTMARK_FROM_EMAIL=<verified sender>
```

`CRON_SECRET` just stops the public function URL from being invoked by
anyone who finds it; the scheduler checks it against an `x-cron-secret`
header.

### Wiring the schedule

The function expects to be invoked every ~5 minutes. This project uses
**Supabase Dashboard → Cron Jobs** (Database → Cron Jobs in the left nav;
some projects show it under Integrations → Cron). Set it up as:

1. **Database → Cron Jobs → Create a new cron job.**
2. **Name**: `chur9-notification-sweep`.
3. **Schedule**: `*/5 * * * *` (every 5 minutes).
4. **Type**: HTTP Request.
5. **Method**: `POST`.
6. **URL**: `https://<project-ref>.supabase.co/functions/v1/notification-scheduler`
   — find `<project-ref>` in Project Settings → General (it's the same
   string as in your `EXPO_PUBLIC_SUPABASE_URL`).
7. **HTTP Headers**: add one —
   `x-cron-secret: <same value you set for the CRON_SECRET secret>`.
8. **HTTP Body**: `{}` (the function doesn't read the body, but the field
   usually needs something in it).
9. Save.

That single header is doing the authentication — the function was
deployed with `--no-verify-jwt` (see above), so no Authorization header is
needed here, only `x-cron-secret`, which the function checks itself.

This is dashboard-only state, not something checked into the repo — if you
ever need to reproduce it via SQL/CLI instead (e.g. scripting a new
environment), the equivalent is pg_cron + pg_net:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'chur9-notification-sweep',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/notification-scheduler',
    headers := jsonb_build_object('x-cron-secret', '<same value as CRON_SECRET>'),
    body := '{}'::jsonb
  );
  $$
);
```

## Client (Expo) setup

Already wired in code (`src/lib/pushNotifications.ts`, `App.tsx`,
`src/navigation/RootNavigator.tsx`, Notification settings screen). What's
still needed from your side:

1. **`eas init`** (needs an Expo account) — links this project to EAS and
   writes `extra.eas.projectId` into `app.json`. Without it,
   `registerForPushNotificationsAsync` logs a warning and no-ops instead of
   crashing.
2. **Firebase project + FCM V1 credentials.** Two separate things, both
   needed:
   - `google-services.json` (Firebase Console → Project Settings → your
     Android app → download) → `google-services.json` at the repo root,
     referenced via `android.googleServicesFile` in `app.json`. The native
     FCM SDK linked into the Android build needs this to initialize
     `FirebaseMessaging` at all — without it, `expo-notifications` throws
     "unable to get Firebase messaging instance" on device, even though
     Expo's push service is what actually delivers the payload.
     (Corrected from an earlier version of this doc that said this file
     wasn't needed for push-only usage — it is.)
   - A service account key (Project Settings → Service Accounts → Generate
     new private key) uploaded via `eas credentials` under Android → Push
     Notifications — this is what lets Expo's push service authenticate to
     *your* FCM project (V1 API) when it relays a push, separate from the
     native SDK init above.
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
4. **Postmark Server API Token + verified sender** (see above) for the email
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
- **The push is data-only — no top-level title/body.** Originally sent as
  a normal Expo push (title/body/categoryId/channelId at the top level),
  which worked for delivery but never showed the Done/Snooze buttons: on
  Android, a push carrying title/body gets auto-displayed by Google Play
  Services' own FCM SDK before the app's code ever runs (confirmed via adb
  logcat — an auto-posted `NotificationRecord` tagged
  `FCM-Notification:...`, no actions attached, category never consulted).
  Fixed by moving title/body into `data` and having the client build +
  present the notification itself (`presentReminderNotification` in
  `src/lib/pushNotifications.ts`, via `scheduleNotificationAsync` with
  `categoryIdentifier` set) from both a foreground listener and a
  `expo-task-manager` background task — the same mechanism now registers
  on iOS too, since a silent push doesn't get OS-auto-displayed there
  either once title/body move out of the top level.
- **iOS action buttons**: registered the same `task_reminder` category on
  both platforms, but background (app-not-running) handling of a tapped
  action is Android-only for now (`expo-task-manager` background
  notification task). iOS can still handle actions via the
  foreground/cold-start listener paths, but the "handle it without fully
  opening the app" behavior Android gets natively isn't wired for iOS — the
  brief already scopes iOS verification as blocked on the Apple Developer
  account anyway.
- **Push delivery receipts** (`migrations/0003_push_receipts.sql`): a
  ticket from Expo's send call only means Expo accepted the message into
  its own queue, not that FCM/APNs or the device ever got it — a silent
  drop (bad/expired push credentials, `DeviceNotRegistered`, rate
  limiting) looks identical to "the device just didn't present it"
  without checking receipts separately. `sweepReceipts` in
  `notification-scheduler/index.ts` follows up on each ticket ~2 minutes
  after sending (Expo's queue is async) and records the result on the
  `notifications` row (`receipt_checked_at`, `expo_receipt_error`) —
  check there first the next time a push looks like it vanished, before
  reaching for a live logcat capture. A `DeviceNotRegistered` receipt
  also clears that user's `push_token` so future sweeps stop sending to a
  dead device.
