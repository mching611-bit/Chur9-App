// Chur9 M2 notification engine — periodic sweep.
//
// Meant to be invoked every ~5 minutes (see supabase/README.md for the
// pg_cron + pg_net wiring, or Supabase's dashboard Cron Jobs for Edge
// Functions). Each run:
//   1. Escalation sweep — notifications nobody responded to within the
//      ignore threshold get marked timed-out and bump their task
//      instance's `consecutive_ignored` counter.
//   2. Due sweep — task instances whose `next_notification_at` has passed
//      get a push (and, once escalated, an opt-in email) sent, a
//      `notifications` row logged, and their next nag time computed.
//   3. Heads-up sweep — a single calm reminder 30 minutes before due,
//      unrelated to Churless level/escalation. Quiet hours suppress a
//      given occurrence outright (no reschedule) rather than delay it
//      past the point of being useful. See sweepHeadsUpReminders.
//   4. Receipts sweep — follows up on tickets from a prior run to confirm
//      actual delivery, not just Expo accepting the send.
//
// Runs with the service role key (bypasses RLS by design — this is the one
// piece of the system that must see every user's due nags at once).

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  computeNextNotificationTime,
  hasExhaustedReminders,
  isWithinQuietHours,
  localHour,
  MIN_SAMPLES_PER_BUCKET,
  rescheduleOutsideBusyBlock,
  rescheduleOutsideQuietHours,
  shouldEscalateToEmail,
} from "../_shared/scheduling.ts";
import type { BusyInterval } from "../_shared/scheduling.ts";
import { checkExpoPushReceipts, ExpoPushMessage, sendExpoPushNotifications } from "../_shared/expoPush.ts";
import { sendEmail } from "../_shared/email.ts";
import { fetchWithTimeout } from "../_shared/fetchWithTimeout.ts";

const IGNORED_THRESHOLD_MINUTES = 20; // brief suggests 15-30 min; tune later.
const HEADS_UP_LEAD_MINUTES = 30; // fixed regardless of Churless level, per the follow-up brief.

interface UserRow {
  id: string;
  email: string;
  push_token: string | null;
  email_opt_in: boolean;
  heads_up_enabled: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  timezone: string;
}

interface TaskRow {
  id: string;
  title: string;
  churless_level: number;
  user_id: string;
  users: UserRow;
}

interface DueInstanceRow {
  id: string;
  notification_count: number;
  consecutive_ignored: number;
  tasks: TaskRow;
}

interface HeadsUpCandidateRow {
  id: string;
  due_at: string;
  tasks: TaskRow;
}

Deno.serve(async (req) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("x-cron-secret") !== cronSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY", { status: 500 });
  }
  // global.fetch: a stalled call to Supabase's own API (this client had no
  // timeout at all until now) can hang the whole sweep forever with zero
  // error logged — see _shared/fetchWithTimeout.ts and the calendar-sync
  // fix this mirrors.
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    global: { fetch: fetchWithTimeout },
  });

  const now = new Date();

  try {
    const expoAccessToken = Deno.env.get("EXPO_ACCESS_TOKEN") ?? undefined;
    const escalated = await sweepEscalations(supabase, now);
    const sent = await sweepDueNotifications(supabase, now);
    const headsUp = await sweepHeadsUpReminders(supabase, now, expoAccessToken);
    const receiptsChecked = await sweepReceipts(supabase, now, expoAccessToken);
    return new Response(JSON.stringify({ ok: true, escalated, sent, headsUp, receiptsChecked }), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("notification-scheduler failed", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});

async function sweepEscalations(supabase: SupabaseClient, now: Date): Promise<number> {
  const threshold = new Date(now.getTime() - IGNORED_THRESHOLD_MINUTES * 60_000).toISOString();

  const { data, error } = await supabase
    .from("notifications")
    .select(
      "id, task_instance_id, task_instances!inner(id, status, notification_count, consecutive_ignored, tasks!inner(churless_level))"
    )
    .is("action_taken", null)
    .lt("sent_at", threshold)
    // Not .eq("status", "active") — an overdue instance still needs
    // escalation just as much as an active one; only "completed" should
    // stop it. (task_instances.status is M1's due_at-vs-now concept,
    // flipped lazily whenever that user's task list loads client-side —
    // unrelated to whether the notification engine should still be
    // nagging about it.)
    .neq("task_instances.status", "completed")
    // The pre-due heads-up is deliberately "no escalation, no repeat" —
    // exclude it here rather than let an unanswered heads-up get treated
    // as an ignored escalation nag.
    .eq("kind", "reminder");

  if (error) throw new Error(`sweepEscalations select failed: ${error.message}`);
  const rows = (data ?? []) as unknown as Array<{
    id: string;
    task_instance_id: string;
    task_instances: {
      notification_count: number;
      consecutive_ignored: number;
      tasks: { churless_level: number };
    };
  }>;

  for (const row of rows) {
    const ti = row.task_instances;
    const nextConsecutiveIgnored = ti.consecutive_ignored + 1;
    const exhausted = hasExhaustedReminders(ti.tasks.churless_level, ti.notification_count);

    const { error: notifErr } = await supabase
      .from("notifications")
      .update({ action_taken: "none" })
      .eq("id", row.id);
    if (notifErr) console.error("failed to mark notification timed out", row.id, notifErr.message);

    const { error: tiErr } = await supabase
      .from("task_instances")
      .update({
        consecutive_ignored: nextConsecutiveIgnored,
        // Bring the next nag forward immediately unless this level has no
        // reminders left to give (level 1/2 already sent its budget).
        ...(exhausted ? {} : { next_notification_at: now.toISOString() }),
      })
      .eq("id", row.task_instance_id);
    if (tiErr) console.error("failed to bump escalation", row.task_instance_id, tiErr.message);
  }

  return rows.length;
}

async function sweepDueNotifications(supabase: SupabaseClient, now: Date): Promise<number> {
  const { data, error } = await supabase
    .from("task_instances")
    .select(
      "id, notification_count, consecutive_ignored, tasks!inner(id, title, churless_level, user_id, users!inner(id, email, push_token, email_opt_in, quiet_hours_start, quiet_hours_end, timezone))"
    )
    // Not .eq("status", "active") — see the comment on the same filter in
    // sweepEscalations above; an overdue instance must keep nagging too,
    // only a completed one should stop.
    .neq("status", "completed")
    .not("next_notification_at", "is", null)
    .lte("next_notification_at", now.toISOString());

  if (error) throw new Error(`sweepDueNotifications select failed: ${error.message}`);
  const dueInstances = (data ?? []) as unknown as DueInstanceRow[];

  const expoAccessToken = Deno.env.get("EXPO_ACCESS_TOKEN") ?? undefined;
  const postmarkServerToken = Deno.env.get("POSTMARK_SERVER_TOKEN");
  const postmarkFrom = Deno.env.get("POSTMARK_FROM_EMAIL");

  const pushMessages: ExpoPushMessage[] = [];
  const notificationInserts: Record<string, unknown>[] = [];
  let sentCount = 0;

  for (const instance of dueInstances) {
    // Each instance isolated: one row throwing (a malformed timezone, a
    // dropped connection, anything) must not silently abort every other
    // due instance in this sweep along with it. Previously the whole loop
    // ran unguarded and a single exception here would propagate out to the
    // top-level handler, failing the entire sweep with no indication of
    // which row caused it.
    try {
      const task = instance.tasks;
      const user = task.users;
      const timeZone = user.timezone || "UTC";

      if (isWithinQuietHours(now, timeZone, user.quiet_hours_start, user.quiet_hours_end)) {
        const rescheduled = rescheduleOutsideQuietHours(
          now,
          timeZone,
          user.quiet_hours_start!,
          user.quiet_hours_end!
        );
        const { error: quietHoursUpdateErr } = await supabase
          .from("task_instances")
          .update({ next_notification_at: rescheduled.toISOString() })
          .eq("id", instance.id);
        if (quietHoursUpdateErr) {
          console.error("failed to reschedule past quiet hours", instance.id, quietHoursUpdateErr.message);
        }
        continue;
      }

      // M4 calendar suppression — same "random point in the next open window"
      // reschedule pattern as quiet hours above, just bounded by the user's
      // synced busy_blocks cache (from either connected provider) instead of
      // a fixed daily window. See rescheduleOutsideBusyBlock in
      // _shared/scheduling.ts. Reads only the cache — never calls Google (or,
      // later, Microsoft) directly, so this stays out of any live API call in
      // the notification-firing critical path.
      const busyBlocks = await fetchUpcomingBusyBlocks(supabase, user.id, now);
      const rescheduledPastBusyBlock = rescheduleOutsideBusyBlock(now, busyBlocks);
      if (rescheduledPastBusyBlock) {
        const { error: busyBlockUpdateErr } = await supabase
          .from("task_instances")
          .update({ next_notification_at: rescheduledPastBusyBlock.toISOString() })
          .eq("id", instance.id);
        if (busyBlockUpdateErr) {
          console.error("failed to reschedule past busy block", instance.id, busyBlockUpdateErr.message);
        }
        continue;
      }

      if (!user.push_token) {
        // Nothing to send yet (device not registered) — leave
        // next_notification_at untouched so this instance is simply
        // re-checked next sweep rather than burning a "reminder" that never
        // reached anyone.
        console.log(
          `sweepDueNotifications: user ${user.id} instance ${instance.id} — no push_token, leaving next_notification_at unchanged`
        );
        continue;
      }

      const escalateToEmail = shouldEscalateToEmail(instance.consecutive_ignored) && user.email_opt_in;

      const notificationId = crypto.randomUUID();
      notificationInserts.push({
        id: notificationId,
        user_id: user.id,
        task_instance_id: instance.id,
        channel: "push",
        kind: "reminder",
        sent_at: now.toISOString(),
      });
      pushMessages.push({
        to: user.push_token,
        priority: "high",
        _contentAvailable: true,
        // No top-level title/body — see the comment on ExpoPushMessage in
        // _shared/expoPush.ts for why. The client builds the actual
        // notification from these fields itself.
        data: {
          notificationId,
          taskInstanceId: instance.id,
          taskId: task.id,
          title: "Chur9",
          body: task.title,
        },
      });
      sentCount++;

      if (escalateToEmail && postmarkServerToken && postmarkFrom) {
        notificationInserts.push({
          id: crypto.randomUUID(),
          user_id: user.id,
          task_instance_id: instance.id,
          channel: "email",
          kind: "reminder",
          sent_at: now.toISOString(),
        });
        await sendEmail({
          to: user.email,
          from: postmarkFrom,
          serverToken: postmarkServerToken,
          subject: `Still outstanding: ${task.title}`,
          text: `You haven't responded to a reminder for "${task.title}". Open Chur9 to mark it done or snooze it.`,
        });
      }

      const avgResponseMinutesByHour = await computeAvgResponseByHour(supabase, user.id, timeZone);
      const next = computeNextNotificationTime({
        churlessLevel: task.churless_level,
        notificationCount: instance.notification_count + 1,
        consecutiveIgnored: instance.consecutive_ignored,
        now,
        timeZone,
        quietHoursStart: user.quiet_hours_start,
        quietHoursEnd: user.quiet_hours_end,
        avgResponseMinutesByHour,
      });

      const { error: sentUpdateErr } = await supabase
        .from("task_instances")
        .update({
          notification_count: instance.notification_count + 1,
          next_notification_at: next ? next.toISOString() : null,
        })
        .eq("id", instance.id);
      if (sentUpdateErr) {
        // The push was already queued above (sentCount/pushMessages) even
        // though this bookkeeping update failed — flagging loudly since a
        // push may go out with the DB never reflecting it, which looks
        // from the row alone like nothing happened at all.
        console.error(
          "sent a push but failed to update notification_count/next_notification_at",
          instance.id,
          sentUpdateErr.message
        );
      }
    } catch (err) {
      console.error("sweepDueNotifications failed for instance", instance.id, err);
    }
  }

  if (notificationInserts.length > 0) {
    const { error: insertErr } = await supabase.from("notifications").insert(notificationInserts);
    if (insertErr) console.error("failed to log sent notifications", insertErr.message);
  }

  const tickets = await sendExpoPushNotifications(pushMessages, expoAccessToken);
  await persistExpoTicketIds(supabase, pushMessages, tickets);

  return sentCount;
}

/**
 * A ticket is Expo accepting the message into its own queue, not proof of
 * delivery — stash the ticket id so sweepReceipts can follow up later and
 * find out whether FCM/APNs (and the device) actually got it. Shared
 * between sweepDueNotifications and sweepHeadsUpReminders, both of which
 * send pushes the same way.
 */
async function persistExpoTicketIds(
  supabase: SupabaseClient,
  pushMessages: ExpoPushMessage[],
  tickets: Array<{ id?: string } | undefined>
): Promise<void> {
  for (let i = 0; i < pushMessages.length; i++) {
    const ticket = tickets[i];
    const notificationId = pushMessages[i].data.notificationId as string | undefined;
    if (!ticket?.id || !notificationId) continue;
    const { error } = await supabase
      .from("notifications")
      .update({ expo_ticket_id: ticket.id })
      .eq("id", notificationId);
    if (error) console.error("failed to save expo_ticket_id", notificationId, error.message);
  }
}

/**
 * A single, calm, non-escalating reminder HEADS_UP_LEAD_MINUTES before a
 * task's due time — deliberately not part of the Churless-level intensity
 * system. Fires once per task_instance (heads_up_sent flips true whether
 * it actually sent or was suppressed by quiet hours) and never touches
 * notification_count/consecutive_ignored, which is what keeps it out of
 * the escalation engine's accounting and lets a task completed via this
 * reminder still qualify for a future "zero post-due nags" points bonus.
 */
async function sweepHeadsUpReminders(
  supabase: SupabaseClient,
  now: Date,
  expoAccessToken?: string
): Promise<number> {
  // Candidates due soon enough that the heads-up window might already be
  // open; the exact "is now within [due - 30min, due)" check happens in
  // JS below per row, since that's a computed comparison Postgres filters
  // can't express through the query builder here.
  const horizon = new Date(now.getTime() + HEADS_UP_LEAD_MINUTES * 60_000).toISOString();

  const { data, error } = await supabase
    .from("task_instances")
    .select(
      "id, due_at, tasks!inner(id, title, user_id, users!inner(id, push_token, heads_up_enabled, quiet_hours_start, quiet_hours_end, timezone))"
    )
    .neq("status", "completed")
    .eq("heads_up_sent", false)
    .gt("due_at", now.toISOString())
    .lte("due_at", horizon);

  if (error) {
    console.error("sweepHeadsUpReminders select failed", error.message);
    return 0;
  }
  const candidates = (data ?? []) as unknown as HeadsUpCandidateRow[];

  const pushMessages: ExpoPushMessage[] = [];
  const notificationInserts: Record<string, unknown>[] = [];
  const resolvedInstanceIds: string[] = []; // sent OR permanently skipped — either way, done
  let sentCount = 0;

  for (const candidate of candidates) {
    const task = candidate.tasks;
    const user = task.users;
    if (!user.heads_up_enabled) continue; // leave unresolved: re-checked if they turn it on before due

    const dueAt = new Date(candidate.due_at);
    const headsUpAt = new Date(dueAt.getTime() - HEADS_UP_LEAD_MINUTES * 60_000);
    if (headsUpAt.getTime() > now.getTime()) continue; // window not open yet

    const timeZone = user.timezone || "UTC";
    // Spec: if the ideal 30-minutes-before instant falls inside quiet
    // hours, skip this occurrence's heads-up entirely — don't reschedule
    // it, since a heads-up that arrives after (or right at) the due time
    // defeats its purpose. Checked against headsUpAt itself, not `now`,
    // so cron timing/jitter can't change the outcome.
    if (isWithinQuietHours(headsUpAt, timeZone, user.quiet_hours_start, user.quiet_hours_end)) {
      resolvedInstanceIds.push(candidate.id);
      continue;
    }

    if (!user.push_token) continue; // no device yet; leave unresolved, retry later

    const notificationId = crypto.randomUUID();
    notificationInserts.push({
      id: notificationId,
      user_id: user.id,
      task_instance_id: candidate.id,
      channel: "push",
      kind: "heads_up",
      sent_at: now.toISOString(),
    });
    pushMessages.push({
      to: user.push_token,
      priority: "high",
      _contentAvailable: true,
      data: {
        notificationId,
        taskInstanceId: candidate.id,
        taskId: task.id,
        title: "Heads up",
        body: task.title,
      },
    });
    resolvedInstanceIds.push(candidate.id);
    sentCount++;
  }

  if (notificationInserts.length > 0) {
    const { error: insertErr } = await supabase.from("notifications").insert(notificationInserts);
    if (insertErr) console.error("failed to log heads-up notifications", insertErr.message);
  }

  const tickets = await sendExpoPushNotifications(pushMessages, expoAccessToken);
  await persistExpoTicketIds(supabase, pushMessages, tickets);

  if (resolvedInstanceIds.length > 0) {
    const { error: markErr } = await supabase
      .from("task_instances")
      .update({ heads_up_sent: true })
      .in("id", resolvedInstanceIds);
    if (markErr) console.error("failed to mark heads_up_sent", markErr.message);
  }

  return sentCount;
}

const RECEIPT_MIN_AGE_MINUTES = 2; // give Expo's queue time to actually process the ticket
const RECEIPT_MAX_AGE_HOURS = 24; // Expo drops receipts after roughly this long
const RECEIPT_BATCH_LIMIT = 100;

/**
 * Follows up on tickets from a prior sweep to find out whether the push
 * actually reached FCM/APNs — a ticket status of "ok" only means Expo
 * accepted the message into its own queue. This is what would have shown
 * the "Testing 8" push (ticket ok, nothing ever arrived) failing for a
 * reason like DeviceNotRegistered or an FCM credential problem, without
 * needing a live on-device logcat capture to find out.
 */
async function sweepReceipts(supabase: SupabaseClient, now: Date, accessToken?: string): Promise<number> {
  const recentCutoff = new Date(now.getTime() - RECEIPT_MIN_AGE_MINUTES * 60_000).toISOString();
  const oldCutoff = new Date(now.getTime() - RECEIPT_MAX_AGE_HOURS * 3600_000).toISOString();

  const { data, error } = await supabase
    .from("notifications")
    .select("id, user_id, expo_ticket_id")
    .eq("channel", "push")
    .not("expo_ticket_id", "is", null)
    .is("receipt_checked_at", null)
    .lt("sent_at", recentCutoff)
    .gt("sent_at", oldCutoff)
    .limit(RECEIPT_BATCH_LIMIT);

  if (error) {
    console.error("sweepReceipts select failed", error.message);
    return 0;
  }
  const rows = (data ?? []) as { id: string; user_id: string; expo_ticket_id: string }[];
  if (rows.length === 0) return 0;

  const receipts = await checkExpoPushReceipts(
    rows.map((r) => r.expo_ticket_id),
    accessToken
  );

  for (const row of rows) {
    const receipt = receipts[row.expo_ticket_id];
    // Not back yet from Expo — leave receipt_checked_at null so this row
    // gets retried next sweep, same as before.
    if (!receipt) continue;

    const receiptError =
      receipt.status === "error" ? receipt.details?.error ?? receipt.message ?? "unknown" : null;
    if (receiptError) {
      console.error("Expo push receipt error", { notificationId: row.id, error: receiptError });
    }

    await supabase
      .from("notifications")
      .update({ receipt_checked_at: now.toISOString(), expo_receipt_error: receiptError })
      .eq("id", row.id);

    // DeviceNotRegistered means this token is dead (app uninstalled, or
    // Expo rotated it) — clear it so future sweeps stop wasting sends on
    // it; registerForPushNotificationsAsync issues a fresh one next time
    // the app opens.
    if (receiptError === "DeviceNotRegistered") {
      await supabase.from("users").update({ push_token: null }).eq("id", row.user_id);
    }
  }

  return rows.length;
}

async function computeAvgResponseByHour(
  supabase: SupabaseClient,
  userId: string,
  timeZone: string
): Promise<Map<number, number>> {
  const { data, error } = await supabase
    .from("notifications")
    .select("sent_at, responded_at")
    .eq("user_id", userId)
    .not("responded_at", "is", null)
    .order("sent_at", { ascending: false })
    .limit(200);

  const result = new Map<number, number>();
  if (error || !data) return result;

  const buckets = new Map<number, number[]>();
  for (const row of data as { sent_at: string; responded_at: string }[]) {
    const sentAt = new Date(row.sent_at);
    const respondedAt = new Date(row.responded_at);
    const minutes = (respondedAt.getTime() - sentAt.getTime()) / 60_000;
    if (minutes < 0) continue;
    const hour = localHour(sentAt, timeZone);
    const arr = buckets.get(hour) ?? [];
    arr.push(minutes);
    buckets.set(hour, arr);
  }

  for (const [hour, minutesList] of buckets) {
    if (minutesList.length >= MIN_SAMPLES_PER_BUCKET) {
      result.set(hour, minutesList.reduce((a, b) => a + b, 0) / minutesList.length);
    }
  }
  return result;
}

const BUSY_BLOCK_FETCH_LIMIT = 50; // bounded — calendar-sync only caches a ~48h horizon per user

/** This user's cached busy_blocks (from any connected provider) at/after `now` — the only calendar data the scheduler ever reads; never a live provider call. */
async function fetchUpcomingBusyBlocks(supabase: SupabaseClient, userId: string, now: Date): Promise<BusyInterval[]> {
  const { data, error } = await supabase
    .from("busy_blocks")
    .select("start_time, end_time")
    .eq("user_id", userId)
    .gt("end_time", now.toISOString())
    .order("start_time", { ascending: true })
    .limit(BUSY_BLOCK_FETCH_LIMIT);

  if (error) {
    console.error("fetchUpcomingBusyBlocks failed", userId, error.message);
    return [];
  }
  return (data ?? []).map((row: { start_time: string; end_time: string }) => ({
    start: new Date(row.start_time),
    end: new Date(row.end_time),
  }));
}
