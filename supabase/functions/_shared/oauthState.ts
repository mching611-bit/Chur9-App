// Signed `state` param for the Google OAuth flow (see
// ../google-oauth-start and ../google-oauth-callback). Google's redirect
// lands on a public Edge Function with no Supabase session attached — state
// is how google-oauth-callback learns which Chur9 user the code belongs to,
// without trusting a client-suppliable value. Signed with
// SUPABASE_SERVICE_ROLE_KEY (already a secret every Edge Function has,
// never sent anywhere but Google as an opaque signed blob) rather than a
// new secret to provision.

async function hmacSha256(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const STATE_TTL_MS = 10 * 60_000; // plenty for a user to complete the Google consent screen

export async function signOAuthState(userId: string, secret: string): Promise<string> {
  const payload = btoa(JSON.stringify({ uid: userId, exp: Date.now() + STATE_TTL_MS }));
  const signature = await hmacSha256(secret, payload);
  return `${payload}.${signature}`;
}

export async function verifyOAuthState(state: string, secret: string): Promise<{ userId: string } | null> {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;
  const expected = await hmacSha256(secret, payload);
  if (!timingSafeEqual(expected, signature)) return null;
  try {
    const parsed = JSON.parse(atob(payload)) as { uid?: unknown; exp?: unknown };
    if (typeof parsed.uid !== "string" || typeof parsed.exp !== "number") return null;
    if (Date.now() > parsed.exp) return null;
    return { userId: parsed.uid };
  } catch {
    return null;
  }
}
