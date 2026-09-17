// Handles the deep link Supabase's confirmation-email link redirects back
// to (see emailRedirectTo in AuthContext's signUp call). supabase-js v2
// defaults to `flowType: 'pkce'` (not overridden anywhere in
// src/lib/supabase.ts), so the email link itself points at Supabase's own
// server, which verifies the one-time token server-side and then redirects
// the browser here with a `code` query param to exchange for a session —
// never tokens directly. The older implicit flow (tokens in the URL
// fragment) is handled too, defensively, in case this project's Auth
// settings ever get switched to it.

import * as Linking from "expo-linking";
import { supabase } from "./supabase";
import { showToast } from "./toast";

const AUTH_CALLBACK_PATH = "auth-callback";

/** Pass this as emailRedirectTo wherever Supabase Auth needs one (signUp, resend, etc). */
export const AUTH_CALLBACK_URL = Linking.createURL(AUTH_CALLBACK_PATH);

function isAuthCallbackUrl(url: string): boolean {
  return Linking.parse(url).path === AUTH_CALLBACK_PATH;
}

/** Tokens for the older implicit flow arrive in the URL fragment (#access_token=...), which Linking.parse doesn't surface as queryParams. */
function parseFragmentParams(url: string): URLSearchParams | null {
  const hashIndex = url.indexOf("#");
  if (hashIndex === -1) return null;
  return new URLSearchParams(url.slice(hashIndex + 1));
}

async function handleAuthCallbackUrl(url: string): Promise<void> {
  const { queryParams } = Linking.parse(url);
  const errorDescription = queryParams?.error_description ?? queryParams?.error;
  if (errorDescription) {
    showToast(
      typeof errorDescription === "string"
        ? errorDescription
        : "That link didn't work — it may be expired."
    );
    return;
  }

  const code = queryParams?.code;
  if (typeof code === "string") {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    showToast(error ? "That confirmation link didn't work — it may be expired." : "Email confirmed.");
    return;
  }

  const fragmentParams = parseFragmentParams(url);
  const accessToken = fragmentParams?.get("access_token");
  const refreshToken = fragmentParams?.get("refresh_token");
  if (accessToken && refreshToken) {
    const { error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    showToast(error ? "That confirmation link didn't work — it may be expired." : "Email confirmed.");
  }
}

/**
 * Call once near the app root. Catches the confirmation-email deep link
 * both on cold start (the app wasn't already running) and while it's
 * already open. Completing the exchange updates the Supabase session,
 * which AuthContext's onAuthStateChange listener picks up on its own — no
 * navigation wiring needed here; RootNavigator swaps from the sign-in
 * stack to the signed-in one automatically once `session` changes.
 */
export function setupAuthDeepLinkHandling(): () => void {
  Linking.getInitialURL().then((url) => {
    if (url && isAuthCallbackUrl(url)) handleAuthCallbackUrl(url);
  });

  const subscription = Linking.addEventListener("url", ({ url }) => {
    if (isAuthCallbackUrl(url)) handleAuthCallbackUrl(url);
  });

  return () => subscription.remove();
}
