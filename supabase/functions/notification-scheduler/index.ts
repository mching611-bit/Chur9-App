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
  rescheduleOutsideQuietHours,
  shouldEscalateToEmail,
} from "../_shared/scheduling.ts";
import { ExpoPushMessage, sendExpoPushNotifications } from "../_shared/expoPush.ts";
import { sendEmail } from "../_shared/email.ts";

const IGNORED_THRESHOLD_MINUTES = 20; // brief suggests 15-30 min; tune later.

interface UserRow {
  id: string;
  email: string;
  push_token: string | null;
  email_opt_in: boolean;
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
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const now = new Date();

  try {
    const escalated = await sweepEscalations(supabase, now);
    const sent = await sweepDueNotifications(supabase, now);
    return new Response(JSON.stringify({ ok: true, escalated, sent }), {
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
    .eq("task_instances.status", "active");

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
    .eq("status", "active")
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
      await supabase
        .from("task_instances")
        .update({ next_notification_at: rescheduled.toISOString() })
        .eq("id", instance.id);
      continue;
    }

    if (!user.push_token) {
      // Nothing to send yet (device not registered) — leave
      // next_notification_at untouched so this instance is simply
      // re-checked next sweep rather than burning a "reminder" that never
      // reached anyone.
      continue;
    }

    const escalateToEmail = shouldEscalateToEmail(instance.consecutive_ignored) && user.email_opt_in;

    const notificationId = crypto.randomUUID();
    notificationInserts.push({
      id: notificationId,
      user_id: user.id,
      task_instance_id: instance.id,
      channel: "push",
      sent_at: now.toISOString(),
    });
    pushMessages.push({
      to: user.push_token,
      title: "Chur9",
      body: task.title,
      categoryId: "task_reminder",
      sound: "default",
      priority: "high",
      data: { notificationId, taskInstanceId: instance.id, taskId: task.id },
    });
    sentCount++;

    if (escalateToEmail && postmarkServerToken && postmarkFrom) {
      notificationInserts.push({
        id: crypto.randomUUID(),
        user_id: user.id,
        task_instance_id: instance.id,
        channel: "email",
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

    await supabase
      .from("task_instances")
      .update({
        notification_count: instance.notification_count + 1,
        next_notification_at: next ? next.toISOString() : null,
      })
      .eq("id", instance.id);
  }

  if (notificationInserts.length > 0) {
    const { error: insertErr } = await supabase.from("notifications").insert(notificationInserts);
    if (insertErr) console.error("failed to log sent notifications", insertErr.message);
  }
  await sendExpoPushNotifications(pushMessages, expoAccessToken);

  return sentCount;
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
