// Chur9 M4 calendar sync — periodic sweep (own cron entry, same pattern as
// notification-scheduler). Meant to be invoked every 15-30 min: for every
// connected calendar, fetches free/busy blocks over a near-term window and
// caches them into busy_blocks so the notification scheduler never has to
// make a live provider call from the notification-firing critical path.
//
// Runs with the service role key (bypasses RLS by design, same as
// notification-scheduler) — it's the one piece of the system that touches
// every user's calendar_connections at once.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { BusyInterval } from "../_shared/scheduling.ts";
import { getBusyBlockFetcher, type CalendarConnectionRow } from "../_shared/calendarProviders.ts";
import { fetchWithTimeout } from "../_shared/fetchWithTimeout.ts";

const SYNC_WINDOW_HOURS = 48; // brief suggests 24-48h; using the wider end since sync only runs every 15-30 min

Deno.serve(async (req) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("x-cron-secret") !== cronSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY", { status: 500 });
  }
  if (!googleClientId || !googleClientSecret) {
    return new Response("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET", { status: 500 });
  }
  // global.fetch: without this, a stalled call to Supabase's own API (not
  // just Google's) can hang this function forever too — see
  // _shared/fetchWithTimeout.ts.
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    global: { fetch: fetchWithTimeout },
  });

  const now = new Date();
  const windowStart = now;
  const windowEnd = new Date(now.getTime() + SYNC_WINDOW_HOURS * 3600_000);

  try {
    const result = await syncAllConnections(supabase, windowStart, windowEnd, googleClientId, googleClientSecret);
    return new Response(JSON.stringify({ ok: true, ...result }), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("calendar-sync failed", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});

async function syncAllConnections(
  supabase: SupabaseClient,
  windowStart: Date,
  windowEnd: Date,
  googleClientId: string,
  googleClientSecret: string
): Promise<{ usersSynced: number; usersFailed: number }> {
  const { data, error } = await supabase
    .from("calendar_connections")
    .select("id, user_id, provider, access_token, refresh_token, expires_at");
  if (error) throw new Error(`Failed to load calendar_connections: ${error.message}`);
  const connections = (data ?? []) as CalendarConnectionRow[];

  const byUser = new Map<string, CalendarConnectionRow[]>();
  for (const connection of connections) {
    const list = byUser.get(connection.user_id) ?? [];
    list.push(connection);
    byUser.set(connection.user_id, list);
  }

  let usersSynced = 0;
  let usersFailed = 0;

  for (const [userId, userConnections] of byUser) {
    try {
      const blocks: BusyInterval[] = [];
      for (const connection of userConnections) {
        const fetchBusyBlocks = getBusyBlockFetcher(connection.provider, googleClientId, googleClientSecret);
        if (!fetchBusyBlocks) continue; // e.g. 'outlook' — schema-ready, no adapter yet
        blocks.push(...(await fetchBusyBlocks(supabase, connection, windowStart, windowEnd)));
      }

      console.log(`calendar-sync: user ${userId} — ${blocks.length} busy block(s) fetched`);

      const { error: replaceError } = await supabase.rpc("replace_busy_blocks", {
        p_user_id: userId,
        p_blocks: blocks.map((b) => ({ start_time: b.start.toISOString(), end_time: b.end.toISOString() })),
      });
      if (replaceError) throw new Error(replaceError.message);
      console.log(`calendar-sync: user ${userId} — busy_blocks replaced successfully`);
      usersSynced++;
    } catch (err) {
      console.error("calendar-sync failed for user", userId, err);
      usersFailed++;
    }
  }

  return { usersSynced, usersFailed };
}
