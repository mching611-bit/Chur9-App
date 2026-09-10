// Pure scheduling logic for the M2 notification engine. No Deno/Supabase
// imports here on purpose: this module is the "platform-agnostic" core the
// build brief asks for — it only knows about churless levels, quiet hours,
// and response-time history, never about FCM/APNs/Expo or the DB client.
// The Edge Function in ../notification-scheduler/index.ts is the only thing
// that wires it to Postgres + a push service.

/** [minMinutes, maxMinutes] gap before the next nag, per churless level. */
const INTERVAL_MINUTES: Record<number, [number, number] | null> = {
  1: null, // single reminder at due time only, no follow-up
  2: [60, 120], // exactly one follow-up in this range
  3: [240, 360],
  4: [180, 240],
  5: [120, 180],
  6: [90, 120],
  7: [60, 90],
  8: [45, 60],
  9: [30, 45],
  10: [25, 35],
};

/** Total reminders (including the due-time one) before a level stops nagging on its own. */
const MAX_REMINDERS: Record<number, number | null> = {
  1: 1,
  2: 2,
  3: null,
  4: null,
  5: null,
  6: null,
  7: null,
  8: null,
  9: null,
  10: null,
};

export function clampChurlessLevel(level: number): number {
  return Math.min(10, Math.max(1, Math.round(level)));
}

/** True once a level-1/level-2 task has used up its fixed reminder budget. */
export function hasExhaustedReminders(level: number, notificationCount: number): boolean {
  const max = MAX_REMINDERS[clampChurlessLevel(level)];
  return max !== null && notificationCount >= max;
}

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Escalation from non-response: each consecutive ignored nag shortens the
 * next interval (floor 10 min) and, from the first ignore, also triggers an
 * email send alongside push (see shouldEscalateToEmail).
 */
export function escalatedIntervalMinutes(level: number, consecutiveIgnored: number): number {
  const range = INTERVAL_MINUTES[clampChurlessLevel(level)];
  if (!range) return 0;
  const [min, max] = range;
  const raw = randomInRange(min, max);
  if (consecutiveIgnored <= 0) return raw;
  const multiplier = Math.max(0.4, 1 - 0.2 * consecutiveIgnored);
  return Math.max(10, raw * multiplier);
}

export function shouldEscalateToEmail(consecutiveIgnored: number): boolean {
  return consecutiveIgnored >= 1;
}

// ---------------------------------------------------------------------------
// Timezone-aware local time helpers (Intl-based; no external deps so this
// runs unmodified in Deno's Edge Function runtime).
// ---------------------------------------------------------------------------

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hour = get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: hour === 24 ? 0 : hour,
    minute: get("minute"),
  };
}

/** UTC instant for a given local wall-clock date+time in `timeZone`. */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  let utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  // A couple of iterations converge for all standard offsets, DST included.
  for (let i = 0; i < 2; i++) {
    const observed = getZonedParts(new Date(utcGuess), timeZone);
    const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute);
    const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute);
    utcGuess -= observedAsUtc - targetAsUtc;
  }
  return new Date(utcGuess);
}

export function parseHHMM(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Next UTC instant at/after `after` (+ minMinutesAhead) whose local wall time in `timeZone` is `hhmm`. */
function nextOccurrenceOfLocalTime(after: Date, timeZone: string, hhmm: string, minMinutesAhead = 0): Date | null {
  const parsed = parseHHMM(hhmm);
  if (!parsed) return null;
  const threshold = after.getTime() + minMinutesAhead * 60_000;
  const local = getZonedParts(after, timeZone);
  let candidate = zonedTimeToUtc(local.year, local.month, local.day, parsed.hour, parsed.minute, timeZone);
  if (candidate.getTime() <= threshold) {
    const nextDay = new Date(candidate.getTime() + 24 * 3600 * 1000);
    const nextLocal = getZonedParts(nextDay, timeZone);
    candidate = zonedTimeToUtc(nextLocal.year, nextLocal.month, nextLocal.day, parsed.hour, parsed.minute, timeZone);
  }
  return candidate;
}

/**
 * Whether `date` falls inside the user's quiet-hours window (in their
 * timezone). Handles windows that wrap midnight (e.g. 22:00-07:00). A
 * missing/empty start or end means "no quiet hours configured".
 */
export function isWithinQuietHours(
  date: Date,
  timeZone: string,
  quietStart: string | null,
  quietEnd: string | null
): boolean {
  if (!quietStart || !quietEnd) return false;
  const start = parseHHMM(quietStart);
  const end = parseHHMM(quietEnd);
  if (!start || !end) return false;
  const local = getZonedParts(date, timeZone);
  const cur = local.hour * 60 + local.minute;
  const startMin = start.hour * 60 + start.minute;
  const endMin = end.hour * 60 + end.minute;
  if (startMin === endMin) return false;
  if (startMin < endMin) return cur >= startMin && cur < endMin;
  return cur >= startMin || cur < endMin;
}

/** Used whenever a reschedule can't determine a real window end (see below). */
export const DEFAULT_WINDOW_FALLBACK_MS = 12 * 3600 * 1000;

/** A random instant in [windowStart, windowEnd) — the shared "pick a random send time in an open window" primitive behind both quiet-hours and busy-block rescheduling. */
export function randomTimeInWindow(windowStart: Date, windowEnd: Date, minSpanMs = 5 * 60_000): Date {
  const spanMs = Math.max(windowEnd.getTime() - windowStart.getTime(), minSpanMs);
  return new Date(windowStart.getTime() + Math.random() * spanMs);
}

/**
 * Given `blockedAt` (a candidate send time that landed inside quiet hours),
 * returns a random instant in the next open window — not simply the moment
 * quiet hours end — so the anti-habituation randomness survives the
 * reschedule.
 */
export function rescheduleOutsideQuietHours(
  blockedAt: Date,
  timeZone: string,
  quietStart: string,
  quietEnd: string
): Date {
  const windowStart = nextOccurrenceOfLocalTime(blockedAt, timeZone, quietEnd) ?? blockedAt;
  const windowEnd =
    nextOccurrenceOfLocalTime(windowStart, timeZone, quietStart, 1) ??
    new Date(windowStart.getTime() + DEFAULT_WINDOW_FALLBACK_MS);
  return randomTimeInWindow(windowStart, windowEnd);
}

// ---------------------------------------------------------------------------
// Busy-block (calendar suppression, M4) rescheduling — same "random point in
// the next open window" pattern as quiet hours above, just bounded by the
// user's synced busy_blocks cache instead of a fixed daily window. Kept
// here (not in the calendar-sync/notification-scheduler functions) since
// this half of the logic is pure interval math with no DB/Deno dependency,
// same as the rest of this module.
// ---------------------------------------------------------------------------

export interface BusyInterval {
  start: Date;
  end: Date;
}

/** Merges overlapping/back-to-back intervals; returns them sorted by start. */
function mergeIntervals(intervals: BusyInterval[]): BusyInterval[] {
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: BusyInterval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start.getTime() <= last.end.getTime()) {
      if (interval.end.getTime() > last.end.getTime()) last.end = interval.end;
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }
  return merged;
}

/**
 * If `at` falls inside one of the user's synced busy blocks, returns a
 * random instant in the next open window after it (bounded by the next
 * busy block, or DEFAULT_WINDOW_FALLBACK_MS if none is cached that far
 * ahead — the sync job only caches a ~48h horizon, so "no next block found"
 * is a normal case here, not just a defensive fallback like in the quiet
 * hours version above). Returns null if `at` isn't inside any block.
 */
export function rescheduleOutsideBusyBlock(at: Date, blocks: BusyInterval[]): Date | null {
  const merged = mergeIntervals(blocks);
  const covering = merged.find((b) => at.getTime() >= b.start.getTime() && at.getTime() < b.end.getTime());
  if (!covering) return null;
  const windowStart = covering.end;
  const next = merged.find((b) => b.start.getTime() > windowStart.getTime());
  const windowEnd = next ? next.start : new Date(windowStart.getTime() + DEFAULT_WINDOW_FALLBACK_MS);
  return randomTimeInWindow(windowStart, windowEnd);
}

// ---------------------------------------------------------------------------
// Send-time learning: bias among several candidate times toward the
// hour-of-day bucket where this user has historically responded fastest.
// Deliberately simple per the brief ("don't over-engineer") — pick the best
// of a handful of random candidates rather than building a real weighted
// distribution.
// ---------------------------------------------------------------------------

const CANDIDATE_COUNT = 4;
/** Need at least this many past responses in an hour bucket to trust it. */
export const MIN_SAMPLES_PER_BUCKET = 3;

export function localHour(date: Date, timeZone: string): number {
  return getZonedParts(date, timeZone).hour;
}

export function pickBestCandidate(
  candidates: Date[],
  timeZone: string,
  avgResponseMinutesByHour: Map<number, number>
): Date {
  if (avgResponseMinutesByHour.size === 0) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  let best = candidates[0];
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const hour = getZonedParts(candidate, timeZone).hour;
    const score = avgResponseMinutesByHour.get(hour);
    if (score !== undefined && score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (!Number.isFinite(bestScore)) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  return best;
}

export interface NextSendInput {
  churlessLevel: number;
  notificationCount: number;
  consecutiveIgnored: number;
  now: Date;
  timeZone: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  avgResponseMinutesByHour: Map<number, number>;
}

/** Returns the next time to nag this task instance, or null if this level's fixed reminder budget is used up. */
export function computeNextNotificationTime(input: NextSendInput): Date | null {
  const level = clampChurlessLevel(input.churlessLevel);
  if (hasExhaustedReminders(level, input.notificationCount)) return null;
  const range = INTERVAL_MINUTES[level];
  if (!range) return null;

  const candidates: Date[] = [];
  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    const minutes = escalatedIntervalMinutes(level, input.consecutiveIgnored);
    let candidate = new Date(input.now.getTime() + minutes * 60_000);
    if (isWithinQuietHours(candidate, input.timeZone, input.quietHoursStart, input.quietHoursEnd)) {
      candidate = rescheduleOutsideQuietHours(
        candidate,
        input.timeZone,
        input.quietHoursStart!,
        input.quietHoursEnd!
      );
    }
    candidates.push(candidate);
  }

  return pickBestCandidate(candidates, input.timeZone, input.avgResponseMinutesByHour);
}
