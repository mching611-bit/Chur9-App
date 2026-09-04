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
  dueAt: Date;
}

export async function createTask(input: CreateTaskInput): Promise<TaskWithInstance> {
  const userId = await getCurrentUserId();

  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .insert({
      user_id: userId,
      title: input.title.trim(),
      type: input.type,
      difficulty: input.difficulty,
      churless_level: input.churlessLevel,
      recurrence_rule: input.type === "recurring" ? input.recurrenceRule : null,
    })
    .select()
    .single();
  if (taskError || !task) throw new Error(taskError?.message ?? "Failed to create task.");

  // One instance now; a recurring task's next instance is generated when
  // this one is completed (see completeTaskInstance below).
  const { data: instance, error: instanceError } = await supabase
    .from("task_instances")
    .insert({ task_id: task.id, due_at: input.dueAt.toISOString(), status: "active" })
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
  dueAt: Date;
}

export async function updateTask(
  taskId: string,
  instanceId: string,
  input: UpdateTaskInput,
  type: TaskType
): Promise<void> {
  const { error: taskError } = await supabase
    .from("tasks")
    .update({
      title: input.title.trim(),
      difficulty: input.difficulty,
      churless_level: input.churlessLevel,
      recurrence_rule: type === "recurring" ? input.recurrenceRule : null,
    })
    .eq("id", taskId);
  if (taskError) throw new Error(taskError.message);

  const { error: instanceError } = await supabase
    .from("task_instances")
    .update({ due_at: input.dueAt.toISOString() })
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
 * ahead" rationale).
 */
export async function completeTaskInstance(task: TaskRow, instance: TaskInstanceRow): Promise<void> {
  const { error } = await supabase
    .from("task_instances")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", instance.id);
  if (error) throw new Error(error.message);

  if (task.type === "recurring" && task.recurrence_rule) {
    const nextDueAt = computeNextDueDate(task.recurrence_rule, new Date(instance.due_at));
    const { error: nextError } = await supabase
      .from("task_instances")
      .insert({ task_id: task.id, due_at: nextDueAt.toISOString(), status: "active" });
    if (nextError) throw new Error(nextError.message);
  }
}

export async function reopenTaskInstance(instanceId: string): Promise<void> {
  const { error } = await supabase
    .from("task_instances")
    .update({ status: "active", completed_at: null })
    .eq("id", instanceId);
  if (error) throw new Error(error.message);
}
