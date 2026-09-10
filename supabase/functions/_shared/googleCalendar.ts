// Google provider adapter for calendar suppression (M4). Implements the
// generic BusyBlockFetcher interface from ./calendarProviders.ts — a future
// getOutlookBusyBlocks() slots in there alongside this one without the sync
// job's orchestration logic changing at all (see calendar-sync/index.ts).

import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { BusyInterval } from "./scheduling.ts";

export interface CalendarConnectionRow {
  id: string;
  user_id: string;
  provider: "google" | "outlook";
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const FREEBUSY_ENDPOINT = "https://www.googleapis.com/calendar/v3/freebusy";
const REFRESH_BUFFER_MS = 5 * 60_000; // refresh a bit before actual expiry, not exactly at it

function needsRefresh(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() - Date.now() < REFRESH_BUFFER_MS;
}

async function refreshAccessToken(
  connection: CalendarConnectionRow,
  clientId: string,
  clientSecret: string
): Promise<{ accessToken: string; expiresAt: string }> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: connection.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token refresh failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  const expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString();
  return { accessToken: json.access_token, expiresAt };
}

/**
 * Refreshes and persists a connection's access token (via the
 * service-role-only upsert_calendar_connection RPC), mutating `connection`
 * in place so subsequent calls in the same sync run see the fresh token.
 */
async function refreshAndPersist(
  supabase: SupabaseClient,
  connection: CalendarConnectionRow,
  clientId: string,
  clientSecret: string
): Promise<void> {
  const { accessToken, expiresAt } = await refreshAccessToken(connection, clientId, clientSecret);
  connection.access_token = accessToken;
  connection.expires_at = expiresAt;
  const { error } = await supabase.rpc("upsert_calendar_connection", {
    p_user_id: connection.user_id,
    p_provider: connection.provider,
    p_access_token: accessToken,
    p_refresh_token: null, // Google doesn't reissue one on refresh; RPC keeps the existing value
    p_expires_at: expiresAt,
  });
  if (error) throw new Error(`Failed to persist refreshed token: ${error.message}`);
}

async function queryFreeBusy(accessToken: string, windowStart: Date, windowEnd: Date): Promise<Response> {
  return fetch(FREEBUSY_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      items: [{ id: "primary" }],
    }),
  });
}

/**
 * Fetches Google's free/busy blocks for `connection`'s owner over
 * [windowStart, windowEnd), refreshing the access token first if it's near
 * expiry, and once more (defensively) if the live call itself comes back
 * unauthorized on an apparently-still-valid token.
 */
export async function getGoogleBusyBlocks(
  supabase: SupabaseClient,
  connection: CalendarConnectionRow,
  windowStart: Date,
  windowEnd: Date,
  clientId: string,
  clientSecret: string
): Promise<BusyInterval[]> {
  if (needsRefresh(connection.expires_at)) {
    await refreshAndPersist(supabase, connection, clientId, clientSecret);
  }

  let res = await queryFreeBusy(connection.access_token, windowStart, windowEnd);
  if (res.status === 401) {
    await refreshAndPersist(supabase, connection, clientId, clientSecret);
    res = await queryFreeBusy(connection.access_token, windowStart, windowEnd);
  }
  if (!res.ok) {
    throw new Error(`Google freebusy.query failed (${res.status}): ${await res.text()}`);
  }

  const json = (await res.json()) as {
    calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }>;
  };
  const primary = json.calendars?.primary;
  if (primary?.errors?.length) {
    throw new Error(`Google freebusy.query returned calendar errors: ${JSON.stringify(primary.errors)}`);
  }
  return (primary?.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
}
