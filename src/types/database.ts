// Hand-written types mirroring supabase/migrations/0001_init_schema.sql.
// If the schema changes, update this file (or swap in `supabase gen types
// typescript` output) to keep it in sync.

export type TaskType = "custom" | "recurring";
export type TaskDifficulty = "easy" | "medium" | "hard";
export type TaskInstanceStatus = "active" | "completed" | "overdue";
export type NotificationChannel = "push" | "email";
export type NotificationAction = "done" | "snooze_30" | "snooze_2hr" | "none";
export type NotificationKind = "reminder" | "heads_up";

export interface UserRow {
  id: string;
  email: string;
  created_at: string;
  default_churless_level: number;
  total_points: number;
  rank: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  email_opt_in: boolean;
  heads_up_enabled: boolean;
  push_token: string | null;
  timezone: string;
}

export interface TaskRow {
  id: string;
  user_id: string;
  title: string;
  type: TaskType;
  difficulty: TaskDifficulty;
  churless_level: number;
  recurrence_rule: string | null;
  created_at: string;
}

export interface TaskInstanceRow {
  id: string;
  task_id: string;
  due_at: string;
  completed_at: string | null;
  status: TaskInstanceStatus;
  next_notification_at: string | null;
  notification_count: number;
  consecutive_ignored: number;
  heads_up_sent: boolean;
}

export interface CalendarEventRow {
  id: string;
  user_id: string;
  task_instance_id: string | null;
  external_event_id: string | null;
  created_at: string;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  task_instance_id: string | null;
  scheduled_for: string | null;
  sent_at: string;
  created_at: string;
  channel: NotificationChannel;
  kind: NotificationKind;
  action_taken: NotificationAction | null;
  responded_at: string | null;
  expo_ticket_id: string | null;
  receipt_checked_at: string | null;
  expo_receipt_error: string | null;
}

export interface PointsLedgerRow {
  id: string;
  user_id: string;
  task_instance_id: string | null;
  points: number;
  created_at: string;
}

// A task joined with the single task_instance the app displays for it.
export interface TaskWithInstance extends TaskRow {
  instance: TaskInstanceRow;
}
