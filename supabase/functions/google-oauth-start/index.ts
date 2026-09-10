// Chur9 M4 — step 1 of the Google Calendar connect flow.
//
// Deployed WITH JWT verification (no --no-verify-jwt), so this only runs
// for an authenticated Supabase user; the app calls it via
// `supabase.functions.invoke("google-oauth-start")`, which attaches the
// user's session JWT automatically. Returns the Google consent URL to open
// in a WebBrowser auth session (see src/lib/calendarAuth.ts).
//
// The Google OAuth client here is a "Web application" type (it has a client
// secret — see supabase/README.md), which means Google requires an https
// redirect_uri, not the app's own custom scheme. So the redirect goes to
// google-oauth-callback (this project's Edge Function URL) instead of
// straight back to the app; that function does the code exchange
// server-side (keeping the client secret off the device entirely) and then
// 302s the browser to the app's chur9:// deep link to close the loop.

import { createClient } from "npm:@supabase/supabase-js@2";
import { signOAuthState } from "../_shared/oauthState.ts";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID");
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !googleClientId) {
    return new Response("Missing required environment/secrets", { status: 500 });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return new Response("Unauthorized", { status: 401 });
  const jwt = authHeader.replace(/^Bearer\s+/i, "");

  // Verified against Supabase Auth itself, not just decoded — this is what
  // actually authenticates the caller, independent of whether the platform
  // gateway's own JWT check is in effect.
  const supabase = createClient(supabaseUrl, anonKey);
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(jwt);
  if (userError || !user) return new Response("Unauthorized", { status: 401 });

  const state = await signOAuthState(user.id, serviceRoleKey);
  const redirectUri = `${supabaseUrl}/functions/v1/google-oauth-callback`;

  const params = new URLSearchParams({
    client_id: googleClientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: FREEBUSY_SCOPE,
    access_type: "offline", // required to get a refresh_token back
    prompt: "consent", // forces a refresh_token on every connect, not just the first
    state,
  });

  return new Response(JSON.stringify({ authorizeUrl: `${GOOGLE_AUTH_ENDPOINT}?${params}` }), {
    headers: { "content-type": "application/json" },
  });
});
