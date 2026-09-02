// M1 keeps recurrence intentionally simple: given a rule and the due date of
// the instance that just came due, compute the single next due date. We only
// ever materialize one task_instance ahead per recurring task (see
// src/api/tasks.ts) — a fuller RRULE-style engine can replace this once the
// notification engine (M2) needs to look further ahead.

export const RECURRENCE_RULES = ["daily", "weekdays", "weekly"] as const;
export type RecurrenceRule = (typeof RECURRENCE_RULES)[number];

export function isRecurrenceRule(value: string): value is RecurrenceRule {
  return (RECURRENCE_RULES as readonly string[]).includes(value);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 0 = Sunday, 6 = Saturday */
function dayOfWeek(date: Date): number {
  return date.getDay();
}

export function computeNextDueDate(rule: string, fromDate: Date): Date {
  switch (rule) {
    case "daily":
      return new Date(fromDate.getTime() + DAY_MS);
    case "weekly":
      return new Date(fromDate.getTime() + 7 * DAY_MS);
    case "weekdays": {
      let next = new Date(fromDate.getTime() + DAY_MS);
      while (dayOfWeek(next) === 0 || dayOfWeek(next) === 6) {
        next = new Date(next.getTime() + DAY_MS);
      }
      return next;
    }
    default:
      // Unknown/custom rule string: fall back to daily rather than throwing,
      // so a hand-entered rule still produces a sensible next instance.
      return new Date(fromDate.getTime() + DAY_MS);
  }
}
