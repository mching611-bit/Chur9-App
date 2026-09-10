import { supabase } from "../lib/supabase";
import type { CalendarConnectionStatus, CalendarProvider } from "../types/database";

/** Status only (provider + timestamps) — the access/refresh tokens never reach the client. */
export async function fetchCalendarConnections(): Promise<CalendarConnectionStatus[]> {
  const { data, error } = await supabase.rpc("get_calendar_connections");
  if (error) throw new Error(error.message);
  return (data ?? []) as CalendarConnectionStatus[];
}

/** Step 1 of the Google Calendar connect flow — see src/lib/calendarAuth.ts for the full flow. */
export async function startGoogleCalendarConnect(): Promise<string> {
  const { data, error } = await supabase.functions.invoke<{ authorizeUrl: string }>("google-oauth-start");
  if (error || !data?.authorizeUrl) {
    throw new Error(error?.message ?? "Failed to start Google Calendar connection.");
  }
  return data.authorizeUrl;
}

export async function disconnectCalendar(provider: CalendarProvider): Promise<void> {
  const { error } = await supabase.rpc("disconnect_calendar_connection", { p_provider: provider });
  if (error) throw new Error(error.message);
}
