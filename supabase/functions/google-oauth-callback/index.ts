// Chur9 M4 — step 2 of the Google Calendar connect flow: where Google
// redirects to after the user approves (or denies) consent.
//
// Deployed with --no-verify-jwt (see supabase/README.md) — Google's
// redirect carries no Supabase session, only `code`/`state`/`error` query
// params, so the platform gateway's JWT check would reject every call here.
// `state` (signed in google-oauth-start) is what authenticates this request
// instead: it proves which Chur9 user started the flow without trusting a
// query param an attacker could otherwise set to attach their own Google
// tokens to someone else's account.
//
// Ends by 302-redirecting the browser to the app's own chur9:// deep link,
// which is what closes the WebBrowser auth session on the client (see
// src/lib/calendarAuth.ts) — the app then re-reads connection status from
// the DB rather than trusting anything in this redirect's query string.

import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyOAuthState } from "../_shared/oauthState.ts";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const APP_REDIRECT_URL = "chur9://google-oauth-callback";

function redirectToApp(params: Record<string, string>): Response {
  const query = new URLSearchParams(params);
  return new Response(null, {
    status: 302,
    headers: { location: `${APP_REDIRECT_URL}?${query}` },
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return redirectToApp({ error: oauthError });
  }
  if (!code || !state) {
    return redirectToApp({ error: "missing_code_or_state" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !googleClientId || !googleClientSecret) {
    return redirectToApp({ error: "server_misconfigured" });
  }

  const verified = await verifyOAuthState(state, serviceRoleKey);
  if (!verified) {
    return redirectToApp({ error: "invalid_or_expired_state" });
  }

  const redirectUri = `${supabaseUrl}/functions/v1/google-oauth-callback`;

  try {
    const tokenRes = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: googleClientId,
        client_secret: googleClientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      console.error("Google token exchange failed", tokenRes.status, await tokenRes.text());
      return redirectToApp({ error: "token_exchange_failed" });
    }

    const tokenJson = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    const expiresAt = new Date(Date.now() + tokenJson.expires_in * 1000).toISOString();

    // A missing refresh_token here (e.g. Google omitted it despite
    // prompt=consent) can't be papered over on a *first* connection — there
    // being no existing row for upsert_calendar_connection's COALESCE to
    // fall back to would otherwise store a connection Chur9 can never
    // refresh. Fail loudly and ask the user to retry rather than silently
    // create a connection doomed to expire in ~1 hour.
    if (!tokenJson.refresh_token) {
      console.error("Google token exchange returned no refresh_token");
      return redirectToApp({ error: "no_refresh_token" });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { error: upsertError } = await supabase.rpc("upsert_calendar_connection", {
      p_user_id: verified.userId,
      p_provider: "google",
      p_access_token: tokenJson.access_token,
      p_refresh_token: tokenJson.refresh_token,
      p_expires_at: expiresAt,
    });
    if (upsertError) {
      console.error("Failed to store calendar connection", upsertError.message);
      return redirectToApp({ error: "storage_failed" });
    }

    return redirectToApp({ ok: "1" });
  } catch (err) {
    console.error("google-oauth-callback failed", err);
    return redirectToApp({ error: "unexpected_error" });
  }
});
