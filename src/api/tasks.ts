import { supabase } from "../lib/supabase";
import { computeNextDueDate } from "../utils/recurrence";
import type {
  TaskDifficulty,
  TaskInstanceRow,
  TaskInstanceStatus,
  TaskRow,
  TaskType,
  TaskWithInstance,
} from "../types/database";

export async function getCurrentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error(error?.message ?? "Not signed in.");
  return data.user.id;
}

/** Flips the caller's own past-due active instances to 'overdue' server-side. */
export async function markOverdueInstances(): Promise<void> {
  const { error } = await supabase.rpc("mark_overdue_task_instances");
  if (error) throw new Error(error.message);
}

/**
 * Fetches the caller's tasks, each paired with the single task_instance the
 * app currently cares about for them. Optionally filtered to one status
 * (active / completed / overdue) for the list tabs.
 */
export async function fetchTasksWithInstances(
  status?: TaskInstanceStatus
): Promise<TaskWithInstance[]> {
  await markOverdueInstances();

  let query = supabase
    .from("task_instances")
    .select("*, tasks(*)")
    .order("due_at", { ascending: true });

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return (data ?? [])
    .filter((row): row is typeof row & { tasks: TaskRow } => row.tasks !== null)
    .map((row) => {
      const { tasks, ...instance } = row as unknown as TaskInstanceRow & { tasks: TaskRow };
      return { ...tasks, instance };
    });
}

export async function fetchTaskWithInstance(
  taskId: string,
  instanceId: string
): Promise<TaskWithInstance> {
  const { data, error } = await supabase
    .from("task_instances")
    .select("*, tasks(*)")
    .eq("id", instanceId)
    .eq("task_id", taskId)
    .single();
  if (error || !data || !data.tasks) throw new Error(error?.message ?? "Task not found.");

  const { tasks, ...instance } = data as unknown as TaskInstanceRow & { tasks: TaskRow };
  return { ...tasks, instance };
}

export interface CreateTaskInput {
  title: string;
  type: TaskType;
  difficulty: TaskDifficulty;
  churlessLevel: number;
  recurrenceRule: string | null;
  /** Custom tasks only — ignored (always true) for recurring/calendar. */
  hasDeadline: boolean;
  /** Null only for a custom task with hasDeadline = false. */
  dueAt: Date | null;
}

export async function createTask(input: CreateTaskInput): Promise<TaskWithInstance> {
  const userId = await getCurrentUserId();

  const hasDeadline = input.type === "custom" ? input.hasDeadline : true;

  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .insert({
      user_id: userId,
      title: input.title.trim(),
      type: input.type,
      difficulty: input.difficulty,
      churless_level: input.churlessLevel,
      recurrence_rule: input.type === "recurring" ? input.recurrenceRule : null,
      has_deadline: hasDeadline,
    })
    .select()
    .single();
  if (taskError || !task) throw new Error(taskError?.message ?? "Failed to create task.");

  // One instance now; a recurring task's next instance is generated when
  // this one is completed (see completeTaskInstance below). A no-deadline
  // custom task gets a null due_at — the initial-notification-time trigger
  // (see supabase/migrations/0008_no_deadline_tasks.sql) starts its nagging
  // from creation time instead.
  const { data: instance, error: instanceError } = await supabase
    .from("task_instances")
    .insert({ task_id: task.id, due_at: input.dueAt ? input.dueAt.toISOString() : null, status: "active" })
    .select()
    .single();
  if (instanceError || !instance) {
    throw new Error(instanceError?.message ?? "Failed to create task instance.");
  }

  return { ...task, instance };
}

export interface UpdateTaskInput {
  title: string;
  difficulty: TaskDifficulty;
  churlessLevel: number;
  recurrenceRule: string | null;
  /** Custom tasks only — ignored (always true) for recurring/calendar. */
  hasDeadline: boolean;
  /** Null only for a custom task with hasDeadline = false. */
  dueAt: Date | null;
}

export async function updateTask(
  taskId: string,
  instanceId: string,
  input: UpdateTaskInput,
  type: TaskType
): Promise<void> {
  const hasDeadline = type === "custom" ? input.hasDeadline : true;

  const { error: taskError } = await supabase
    .from("tasks")
    .update({
      title: input.title.trim(),
      difficulty: input.difficulty,
      churless_level: input.churlessLevel,
      recurrence_rule: type === "recurring" ? input.recurrenceRule : null,
      has_deadline: hasDeadline,
    })
    .eq("id", taskId);
  if (taskError) throw new Error(taskError.message);

  const { error: instanceError } = await supabase
    .from("task_instances")
    .update({ due_at: input.dueAt ? input.dueAt.toISOString() : null })
    .eq("id", instanceId);
  if (instanceError) throw new Error(instanceError.message);
}

export async function deleteTask(taskId: string): Promise<void> {
  const { error } = await supabase.from("tasks").delete().eq("id", taskId);
  if (error) throw new Error(error.message);
}

/**
 * Marks an instance complete. For a recurring task, also inserts the next
 * upcoming instance (see src/utils/recurrence.ts for the "just one instance
 * ahead" rationale). Points are computed server-side by a trigger on this
 * same update (see supabase/migrations/0006_points_scoring.sql) — this just
 * reads back what got awarded so the caller can show it.
 */
export async function completeTaskInstance(task: TaskRow, instance: TaskInstanceRow): Promise<number> {
  const { error } = await supabase
    .from("task_instances")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", instance.id);
  if (error) throw new Error(error.message);

  if (task.type === "recurring" && task.recurrence_rule) {
    // Recurring tasks always have a due_at (only custom tasks can go
    // no-deadline — see 0008_no_deadline_tasks.sql).
    const nextDueAt = computeNextDueDate(task.recurrence_rule, new Date(instance.due_at!));
    const { error: nextError } = await supabase
      .from("task_instances")
      .insert({ task_id: task.id, due_at: nextDueAt.toISOString(), status: "active" });
    if (nextError) throw new Error(nextError.message);
  }

  const { data: ledgerRow, error: ledgerError } = await supabase
    .from("points_ledger")
    .select("points_awarded")
    .eq("task_instance_id", instance.id)
    .single();
  if (ledgerError || !ledgerRow) {
    console.warn("Failed to read awarded points", ledgerError?.message);
    return 0;
  }
  return ledgerRow.points_awarded as number;
}

export async function reopenTaskInstance(instanceId: string): Promise<void> {
  const { error } = await supabase
    .from("task_instances")
    .update({ status: "active", completed_at: null })
    .eq("id", instanceId);
  if (error) throw new Error(error.message);
}
