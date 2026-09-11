// A bare `fetch()` with no deadline can hang a Deno.serve handler forever:
// if the remote stalls (no response, no error, just silence — which
// happens with real-world flaky routes to an external host), the awaited
// promise never settles, so nothing downstream ever runs and the function
// never produces a Response. Every outbound network call in the calendar
// suppression functions (Google's OAuth/Calendar APIs, and the Supabase
// client's own requests via `global.fetch`) should go through this instead
// of a bare `fetch()`.

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
