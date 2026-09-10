// Generic provider adapter interface for calendar suppression (M4). The
// sync job (calendar-sync/index.ts) loops over a user's calendar_connections
// rows and dispatches to the matching adapter here — adding Outlook later
// means implementing getOutlookBusyBlocks() in a sibling module and adding
// one entry to this map, not touching the sync job's orchestration logic.

import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { BusyInterval } from "./scheduling.ts";
import { getGoogleBusyBlocks, type CalendarConnectionRow } from "./googleCalendar.ts";

export type BusyBlockFetcher = (
  supabase: SupabaseClient,
  connection: CalendarConnectionRow,
  windowStart: Date,
  windowEnd: Date
) => Promise<BusyInterval[]>;

/** undefined = provider is schema-ready but has no adapter yet (Outlook, deferred). */
export function getBusyBlockFetcher(
  provider: CalendarConnectionRow["provider"],
  googleClientId: string,
  googleClientSecret: string
): BusyBlockFetcher | undefined {
  if (provider === "google") {
    return (supabase, connection, windowStart, windowEnd) =>
      getGoogleBusyBlocks(supabase, connection, windowStart, windowEnd, googleClientId, googleClientSecret);
  }
  return undefined;
}

export type { CalendarConnectionRow };
