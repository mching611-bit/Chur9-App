// Hand-written types mirroring supabase/migrations/0001_init_schema.sql.
// If the schema changes, update this file (or swap in `supabase gen types
// typescript` output) to keep it in sync.

export type TaskType = "custom" | "recurring";
export type TaskDifficulty = "easy" | "medium" | "hard";
export type TaskInstanceStatus = "active" | "completed" | "overdue";

export interface UserRow {
  id: string;
  email: string;
  created_at: string;
  default_churless_level: number;
  total_points: number;
  rank: string;
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
  sent_at: string | null;
  created_at: string;
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
