// Minimal date/time text-field parsing for the task form. Deliberately plain
// text inputs (no native date picker dependency) to keep M1's form simple and
// consistent across web/iOS/Android; a nicer picker can replace this later.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

export function formatDatePart(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatTimePart(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${min}`;
}

/** Combines a "YYYY-MM-DD" and "HH:MM" string into a local Date, or null if invalid. */
export function parseDateAndTime(datePart: string, timePart: string): Date | null {
  const dateMatch = DATE_RE.exec(datePart.trim());
  const timeOfDay = parseTimeOnly(timePart);
  if (!dateMatch || !timeOfDay) return null;

  const [, y, m, d] = dateMatch;
  const monthNum = Number(m);
  const dayNum = Number(d);
  if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) return null;

  const date = new Date(Number(y), monthNum - 1, dayNum, timeOfDay.hour, timeOfDay.minute, 0, 0);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/** Parses a bare "HH:MM" string, or null if invalid. For a recurring task's definition, which asks for a time of day only (see computeFirstDueDate in utils/recurrence.ts). */
export function parseTimeOnly(timePart: string): { hour: number; minute: number } | null {
  const match = TIME_RE.exec(timePart.trim());
  if (!match) return null;
  const [, h, min] = match;
  const hour = Number(h);
  const minute = Number(min);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}
