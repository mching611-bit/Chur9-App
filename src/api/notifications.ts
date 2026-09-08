import { supabase } from "../lib/supabase";
import { completeTaskInstance, getCurrentUserId } from "./tasks";
import type { NotificationAction, TaskInstanceRow, TaskRow, UserRow } from "../types/database";

const SNOOZE_MINUTES: Record<"snooze_30" | "snooze_2hr", number> = {
  snooze_30: 30,
  snooze_2hr: 120,
};

/** Saves the device's Expo push token so the scheduler can reach this user. */
export async function savePushToken(token: string): Promise<void> {
  const userId = await getCurrentUserId();
  const { error } = await supabase.from("users").update({ push_token: token }).eq("id", userId);
  if (error) throw new Error(error.message);
}

/** Best-effort; called once on sign-in so quiet hours are evaluated in the right wall clock. */
export async function saveDeviceTimezone(timezone: string): Promise<void> {
  const userId = await getCurrentUserId();
  const { error } = await supabase.from("users").update({ timezone }).eq("id", userId);
  if (error) throw new Error(error.message);
}

export interface NotificationPreferencesInput {
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  emailOptIn: boolean;
  headsUpEnabled: boolean;
}

export async function fetchNotificationPreferences(): Promise<UserRow> {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from("users").select("*").eq("id", userId).single();
  if (error || !data) throw new Error(error?.message ?? "Failed to load preferences.");
  return data as UserRow;
}

export async function updateNotificationPreferences(input: NotificationPreferencesInput): Promise<void> {
  const userId = await getCurrentUserId();
  const { error } = await supabase
    .from("users")
    .update({
      quiet_hours_start: input.quietHoursStart,
      quiet_hours_end: input.quietHoursEnd,
      email_opt_in: input.emailOptIn,
      heads_up_enabled: input.headsUpEnabled,
    })
    .eq("id", userId);
  if (error) throw new Error(error.message);
}

/**
 * Handles a Done/Snooze action tapped on a notification (from the
 * foreground response listener or the Android background notification
 * task). Snoozing reschedules the same task_instance's next nag instead of
 * creating a new notification thread, per the M2 brief.
 */
export async function recordNotificationAction(
  notificationId: string,
  action: NotificationAction
): Promise<void> {
  const { data: notification, error: notifError } = await supabase
    .from("notifications")
    .select("task_instance_id")
    .eq("id", notificationId)
    .single();
  if (notifError || !notification?.task_instance_id) {
    throw new Error(notifError?.message ?? "Notification not found.");
  }
  const taskInstanceId = notification.task_instance_id as string;

  const { error: updateNotifError } = await supabase
    .from("notifications")
    .update({ action_taken: action, responded_at: new Date().toISOString() })
    .eq("id", notificationId);
  if (updateNotifError) throw new Error(updateNotifError.message);

  await supabase.from("task_instances").update({ consecutive_ignored: 0 }).eq("id", taskInstanceId);

  if (action === "done") {
    const { data, error } = await supabase
      .from("task_instances")
      .select("*, tasks(*)")
      .eq("id", taskInstanceId)
      .single();
    if (error || !data?.tasks) throw new Error(error?.message ?? "Task not found.");
    const { tasks, ...instance } = data as unknown as TaskInstanceRow & { tasks: TaskRow };
    await completeTaskInstance(tasks, instance);
    return;
  }

  if (action === "snooze_30" || action === "snooze_2hr") {
    const nextAt = new Date(Date.now() + SNOOZE_MINUTES[action] * 60_000);
    // due_at (not just next_notification_at) has to move too: the task
    // list and mark_overdue_task_instances (M1) key off due_at/status, not
    // the M2 scheduling field, and mark_overdue_task_instances only ever
    // flips active -> overdue, never back — so an already-overdue instance
    // needs status reset explicitly or it stays "overdue" forever even
    // once due_at is back in the future.
    const { error } = await supabase
      .from("task_instances")
      .update({
        next_notification_at: nextAt.toISOString(),
        due_at: nextAt.toISOString(),
        status: "active",
      })
      .eq("id", taskInstanceId);
    if (error) throw new Error(error.message);
  }
}
