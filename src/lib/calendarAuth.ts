import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import { startGoogleCalendarConnect } from "../api/calendar";

// Must match the literal redirect Google is sent to after
// google-oauth-callback finishes (see supabase/functions/google-oauth-callback/index.ts).
// Requires a dev-client or standalone build — Expo Go can't be given a
// stable custom-scheme redirect (see app.json's "scheme" and the same
// caveat already noted for push notifications in supabase/README.md).
const APP_REDIRECT_URL = Linking.createURL("google-oauth-callback");

export interface ConnectCalendarResult {
  ok: boolean;
  /** Only set when ok is false; a short code from google-oauth-callback (e.g. "access_denied"), not necessarily user-facing copy. */
  error?: string;
}

/**
 * Opens the Google consent screen in a system auth session and waits for it
 * to complete. The actual token exchange happens entirely server-side (see
 * google-oauth-start/google-oauth-callback) — this function never sees a
 * token, only whether the round trip succeeded. Callers should treat the
 * database (fetchCalendarConnections) as the source of truth for whether a
 * connection now exists, not this return value alone.
 */
export async function connectGoogleCalendar(): Promise<ConnectCalendarResult> {
  const authorizeUrl = await startGoogleCalendarConnect();
  const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, APP_REDIRECT_URL);

  if (result.type !== "success") {
    return { ok: false, error: result.type };
  }

  const { queryParams } = Linking.parse(result.url);
  const error = queryParams?.error;
  if (error) {
    return { ok: false, error: String(error) };
  }
  return { ok: true };
}
