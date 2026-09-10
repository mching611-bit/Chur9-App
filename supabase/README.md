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
5. `migrations/0005_calendar_task_type.sql` — adds `'calendar'` to
   `task_type`, in its own migration/transaction since Postgres won't let a
   just-added enum value be referenced by other DDL until it's committed.
   **Must be run as its own SQL Editor execution, separate from 0006** — see
   the warning below.
6. `migrations/0006_points_scoring.sql` — M3: populates `points_ledger`
   (`points_awarded`, `base_score`), adds the fixed `rank_thresholds` table,
   and wires two triggers — one on `task_instances` that computes and
   inserts a ledger row when an instance flips to `completed`, one on
   `points_ledger` that keeps `users.total_points`/`rank` in sync. See
   "Points/rank scoring (M3)" below.
7. `migrations/0007_backfill_missing_points.sql` — one-time, idempotent
   backfill for any `task_instance` that was already `completed` before
   0006's trigger was actually installed (see the warning below for how
   that happens). Safe to run on any environment, including ones that never
   hit the issue — it's a no-op wherever every completed instance already
   has a `points_ledger` row.
8. `migrations/0008_no_deadline_tasks.sql` — M3.5: adds `tasks.has_deadline`
   (custom tasks only — recurring/calendar always `true`) and drops the
   `not null` constraint on `task_instances.due_at` so a no-deadline custom
   task can have none. Updates `set_initial_notification_time` to anchor a
   no-deadline instance's first nag to creation time instead of `due_at`,
   and `mark_overdue_task_instances` to skip null-`due_at` rows so these
   never show as `'overdue'`. No scheduler code changes — escalation/quiet
   hours already key off `next_notification_at`/`notification_count`, not
   `due_at`.
9. `migrations/0009_calendar_connections.sql` — M4: adds
   `calendar_connections` (OAuth tokens, one row per user+provider) and
   `busy_blocks` (the sync job's cache, safe to fully rebuild), plus the
   security-definer functions that are the only way either table is ever
   touched (`get_calendar_connections`, `disconnect_calendar_connection` for
   the client; `upsert_calendar_connection`, `replace_busy_blocks` for the
   sync job/OAuth callback, both service-role-only). See "Calendar
   suppression (M4)" below.

**0005/0006 must be two separate SQL Editor runs, not one paste.** Pasting
both into the same "Run" sends them as a single implicit transaction —
0006 references the `'calendar'` value 0005 just added, which Postgres
refuses mid-transaction ("unsafe use of new value of enum type added in
this transaction"), and the failure rolls back *everything* in that paste,
0005 included. The visible symptom isn't an obvious break: `task_instances`
updates (status, `completed_at`) keep working fine since they don't touch
any of this, so tasks appear to complete normally — `points_ledger` just
silently never gets a row and `users.total_points`/`rank` never move, with
no client-side error (confirmed via a real incident: a task showed
`completed_at` set correctly with zero `points_ledger` rows and neither
trigger present in `pg_trigger`). Check for it with:

```sql
select tgname, tgenabled from pg_trigger
where tgname in ('task_instances_award_points', 'points_ledger_apply_to_user');
```

If that comes back empty, run 0005 and 0006 again as two separate
executions (both are safe to re-run — see below), then 0007 to backfill
any completions that happened while the triggers were missing.

Every statement in 0005-0007 is written to be safe to re-run from any
partial state (`IF EXISTS`/`IF NOT EXISTS` guards, `CREATE OR REPLACE`,
`ON CONFLICT`) — re-running them is never destructive and always converges
to the same correct end state, whatever state you're starting from.

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

### No-deadline tasks (M3.5)

Custom (one-off) tasks can opt out of having a due time at all
(`tasks.has_deadline = false`, `task_instances.due_at = null`) — for
procrastination-prone tasks where a hard deadline isn't the point.
Deliberately built as a thin variant of the existing engine rather than a
separate system:

- `set_initial_notification_time` (in `0008_no_deadline_tasks.sql`) sets a
  new instance's `next_notification_at` to `due_at`, or `now()` when
  `due_at` is null — so nagging starts immediately from creation time,
  through the same `INTERVAL_MINUTES` table keyed by `churless_level`.
- `mark_overdue_task_instances` skips rows with a null `due_at`, so these
  never become `'overdue'` — only `'active'` or `'completed'`.
- Escalation, quiet hours, and send-time learning are all untouched: every
  bit of that logic (`sweepEscalations`, `sweepDueNotifications`,
  `isWithinQuietHours`, `computeNextNotificationTime`) keys off
  `next_notification_at`/`notification_count`/`consecutive_ignored`, never
  `due_at` directly, so a no-deadline instance escalates exactly like an
  overdue one once its nag goes unanswered past
  `IGNORED_THRESHOLD_MINUTES`.
- The heads-up reminder (above) naturally excludes these — it queries
  `due_at > now()`, which a null `due_at` never satisfies — since "30
  minutes before due" is meaningless without a due time.

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

## Calendar suppression (M4)

Suppression only — mutes nags during a detected busy block on a connected
calendar. No event-surfacing, no event-to-task conversion; both are
explicitly out of scope this milestone per the product simplification that
also dropped points/rank in M3.5. Google only this milestone; Outlook is
deferred (a persistent Microsoft Entra account-provisioning error blocked
completing that app registration), not cancelled — the schema and adapter
interface are provider-agnostic so it's a second adapter later, not a
rework.

### How it fits together

Two-part system, same reason M2's notification-scheduler is split from the
scheduling logic it calls: no live provider API call ever happens in the
notification-firing critical path.

- `supabase/functions/calendar-sync/index.ts` — the sync job (own cron
  entry, same pattern as notification-scheduler). Every 15-30 min, for each
  connected calendar, calls the provider's free/busy endpoint over a
  48-hour window and fully replaces that user's `busy_blocks` cache (all
  providers merged into one list — `busy_blocks` has no `provider` column
  on purpose, since the scheduler only ever needs "is the user busy right
  now from *any* connected calendar").
- `supabase/functions/_shared/calendarProviders.ts` — the provider-agnostic
  adapter interface (`BusyBlockFetcher`) the sync job dispatches through.
  Adding Outlook later means writing `getOutlookBusyBlocks()` in a sibling
  module to `googleCalendar.ts` and adding one entry to
  `getBusyBlockFetcher()` — the sync job's orchestration loop doesn't
  change.
- `supabase/functions/_shared/googleCalendar.ts` — the Google adapter:
  calls `freebusy.query` with the `calendar.freebusy` scope, refreshing the
  access token first if it's near expiry and once more (defensively) if a
  live call comes back 401 on an apparently-still-valid token.
- `supabase/functions/notification-scheduler/index.ts` — unchanged in
  shape, one addition to `sweepDueNotifications`: right alongside the
  existing quiet-hours check, it now also reads the cached `busy_blocks`
  for the current moment (never a live call) and, if busy, reschedules
  using the same "random point in the next open window" primitive quiet
  hours already uses (`randomTimeInWindow` in `_shared/scheduling.ts`,
  factored out of `rescheduleOutsideQuietHours` so both call sites are
  genuinely sharing code, not just pattern-alike). See
  `rescheduleOutsideBusyBlock` for the busy-block-specific window lookup
  (merges overlapping/back-to-back blocks, bounds the window by the next
  synced block or a 12h fallback if none is cached that far ahead).
- Scoped to the main nag/reschedule flow only (`sweepDueNotifications`),
  not the pre-due heads-up reminder (`sweepHeadsUpReminders`) — the brief's
  exit criteria and its "reuse the reschedule function" phrasing both point
  at the reschedule pattern specifically, and heads-up already has its own
  different quiet-hours behavior (skip entirely, never reschedule) that a
  busy-block reschedule wouldn't fit cleanly into. Worth revisiting if a
  future brief asks for it explicitly.

### OAuth flow

The Google OAuth client here is a **Web application** type — it has a
client secret, which Google only allows redirecting to an `https` URL, not
a mobile app's own custom scheme. So the flow has a server-side hop in the
middle, all within Supabase Edge Functions, and the app never sees the
client secret or the authorization code:

1. App calls `google-oauth-start` (deployed **with** JWT verification — the
   Supabase client attaches the signed-in user's session automatically).
   It verifies the caller via `supabase.auth.getUser()`, signs a short-lived
   `state` (HMAC'd with `SUPABASE_SERVICE_ROLE_KEY` — already a secret every
   function has, so no new secret to provision just for this), and returns
   the Google consent URL.
2. App opens that URL via `WebBrowser.openAuthSessionAsync` (see
   `src/lib/calendarAuth.ts`), watching for a redirect back to the app's own
   `chur9://google-oauth-callback` (see `app.json`'s `scheme` — this
   requires a dev-client or standalone build; like push notifications,
   Expo Go can't be given a stable custom-scheme redirect).
3. Google redirects the browser to `google-oauth-callback` (deployed
   **without** JWT verification — Google's redirect carries no Supabase
   session, so the platform gateway's JWT check would reject every call
   here; `state` is what authenticates the request instead). It verifies
   `state`, exchanges the code for tokens server-side, upserts
   `calendar_connections` via the service-role-only
   `upsert_calendar_connection` RPC, then 302s the browser to
   `chur9://google-oauth-callback?ok=1` — the redirect
   `WebBrowser.openAuthSessionAsync` was watching for, which closes the
   auth session and returns control to the app.
4. The app re-reads connection status from `get_calendar_connections()`
   rather than trusting anything in that redirect's query string — the DB
   is the source of truth for whether a connection now exists.

**Redirect URI**: `<SUPABASE_URL>/functions/v1/google-oauth-callback` —
built from the `SUPABASE_URL` every Edge Function already has, so it's
always byte-identical to what `google-oauth-start` sends Google and what's
registered in Google Cloud Console, no separate value to keep in sync. This
is the same path as the placeholder already configured there
(`https://hegrzqyyxukqrdfjxdgs.supabase.co/functions/v1/google-oauth-callback`)
— confirmed, no change needed on the Google Cloud Console side.

Disconnecting doesn't need an Edge Function — the client calls
`disconnect_calendar_connection(provider)` directly, a security-definer SQL
function keyed off `auth.uid()`.

### Token storage and access control

`calendar_connections.access_token`/`refresh_token` are meaningfully more
sensitive than anything else this app stores (compare `users.push_token`,
which is a device identifier, not a live credential to someone's calendar).
Rather than column-level encryption-at-rest (Supabase Vault/pgsodium would
be the next step if that's needed), this milestone protects them with
access control: RLS is enabled on both `calendar_connections` and
`busy_blocks` with **no policies at all** for `anon`/`authenticated` — only
`service_role` (which bypasses RLS by design) can touch these tables
directly. The client's entire read/write surface is the four
security-definer functions in `0009_calendar_connections.sql`
(`get_calendar_connections`, `disconnect_calendar_connection` — callable by
any authenticated user, scoped to `auth.uid()`; `upsert_calendar_connection`,
`replace_busy_blocks` — `service_role` only, explicit `revoke`/`grant` since
Postgres functions are public-executable by default). `busy_blocks` is
never read by the client at all — the build brief is explicit that no
calendar data ever surfaces in the app UI.

### Deploying the functions

```
supabase functions deploy calendar-sync --no-verify-jwt
supabase functions deploy google-oauth-start
supabase functions deploy google-oauth-callback --no-verify-jwt
```

`calendar-sync` needs `--no-verify-jwt` for the same reason
`notification-scheduler` does (a cron trigger has no logged-in user; see
above). `google-oauth-callback` needs it because Google's redirect carries
no Supabase session. `google-oauth-start` is the one function in this
project that keeps the platform's default JWT check — it's meant to be
called by a signed-in user and nothing else.

Set these secrets (in addition to the M2 ones above):

```
supabase secrets set GOOGLE_CLIENT_ID=<from Google Cloud Console>
supabase secrets set GOOGLE_CLIENT_SECRET=<from Google Cloud Console>
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are
injected automatically, same as for `notification-scheduler`.

### Wiring the schedule

Same pattern as `notification-scheduler`'s "Wiring the schedule" above —
**Supabase Dashboard → Cron Jobs**, or the equivalent `pg_cron`/`pg_net`
SQL:

1. **Name**: `chur9-calendar-sync`.
2. **Schedule**: e.g. `*/20 * * * *` (every 20 minutes — brief suggests
   15-30 min).
3. **Type**: HTTP Request, **Method**: `POST`.
4. **URL**: `https://<project-ref>.supabase.co/functions/v1/calendar-sync`.
5. **HTTP Headers**: `x-cron-secret: <same value as the CRON_SECRET secret>`
   (reuses the same secret notification-scheduler checks — both functions
   read the same env var).
6. **HTTP Body**: `{}`.

### Verifying suppression (same method as M2's quiet hours)

Connect Google Calendar from Notification Settings, create a calendar event
covering the current time on the connected calendar, and schedule (or wait
for) a task nag to fall inside it. Confirm: `calendar-sync` populates
`busy_blocks` for that window within one sync interval;
`notification-scheduler` doesn't send the push while `now` is inside a
synced block; `task_instances.next_notification_at` moves to a random
instant after the block's `end_time` (or the start of the next synced
block, if there is one before it); the nag actually fires there on a later
sweep.

## Points/rank scoring (M3)

Computed entirely server-side (`award_points_on_task_completion` trigger on
`task_instances`, fires when `status` flips to `completed`) — never on the
client, since `notification_count` already lives in the DB and points need
the same tamper-resistance.

Base score by difficulty: easy 20, medium 50, hard 100. For `custom` (and
`calendar`, once some future milestone lets a user opt an event into
Churless treatment — schema-ready via `0005_calendar_task_type.sql` but
still not reachable from the app; M4 turned out to be suppression-only, see
"Calendar suppression (M4)" above, with event-to-task conversion dropped
per the product simplification that also shelved points/rank in M3.5):

```
points = MAX(
  base_score - (notification_count * 5) + zero_nag_bonus + honesty_bonus,
  base_score * 0.3
)
```

- `zero_nag_bonus` = `base_score * 0.2` if `notification_count == 0` at
  completion, else 0. Since the pre-due heads-up reminder never touches
  `notification_count` (see "Heads-up reminder" above), a task completed
  from that reminder qualifies automatically — no special-casing needed.
- `honesty_bonus` = flat `+10` if the task's `churless_level >= 7`,
  regardless of nag count.

`recurring` tasks skip this formula entirely and just award
`base_score * 0.5` — flat, no nag penalty/bonus, kept lower-value than
`custom` on purpose without building streak tracking yet.

A second trigger (`apply_points_ledger_entry`, on `points_ledger` inserts)
adds the awarded points to `users.total_points` and recomputes
`users.rank` from the fixed `rank_thresholds` table (Intern 0 → Partner
60,000). `points_ledger.task_instance_id` is unique, so a completed
instance can only ever be scored once — closes off a
reopen-then-re-complete loop (`reopenTaskInstance` in `src/api/tasks.ts`)
from farming duplicate awards for the same occurrence.

**UI hidden as of M3.5:** the "Profile" link (points/rank screen) and the
"+N pts" completion toast are both removed from the app, at the user's
request, in case this comes back in a future version — the backend above
(trigger, `points_ledger`, `rank_thresholds`, `users.total_points`/`rank`)
keeps running exactly as described, just silently. `completeTaskInstance`
in `src/api/tasks.ts` still reads the ledger row back and returns the
points awarded; callers (`src/screens/TaskListScreen.tsx`,
`src/api/notifications.ts`) just no longer toast it. `ProfileScreen` and
its route are still in the codebase, unreachable from the UI.

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
5. **A development build for Google Calendar connect too**, same
   requirement and reason as #3 above: the OAuth redirect needs the app's
   own stable `chur9://` scheme (`app.json`'s `scheme`), which Expo Go can't
   provide (`expo-linking`'s `createURL` docs are explicit that its output
   "is neither stable nor predictable" there). If you already have a dev
   client from #3, no separate build is needed — this reuses it.

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
