// Sends push notifications via the Expo Push API (https://exp.host). Using
// Expo's service (rather than calling FCM/APNs directly) is what makes the
// engine platform-agnostic per the M2 brief: it fans out to Android (FCM)
// and iOS (APNs) from the same call, keyed only by each device's Expo push
// token.

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const BATCH_SIZE = 100; // Expo's documented max messages per request.

export interface ExpoPushMessage {
  to: string;
  // Deliberately no top-level title/body: on Android, a push that carries
  // them gets auto-displayed by Google Play Services' FCM SDK — a plain
  // system notification with no idea our "task_reminder" category exists —
  // before this app's own code ever runs (confirmed via adb logcat: an
  // auto-posted `NotificationRecord` tagged `FCM-Notification:...`, and no
  // actions attached). Put title/body inside `data` instead; the client
  // (src/lib/pushNotifications.ts) reads them from there and builds +
  // presents the notification itself via scheduleNotificationAsync, with
  // the category correctly attached. `categoryId`/`channelId` server-side
  // fields are gone for the same reason — they only mattered for the
  // auto-display path we're no longer using.
  data: Record<string, unknown>;
  priority?: "default" | "normal" | "high";
  // Expo Push API field for a silent/background push (maps to APNs
  // content-available on iOS; harmless no-op for Android, which always
  // delivers data messages to the app regardless of this flag — set for
  // both since the engine is meant to be platform-agnostic).
  _contentAvailable?: boolean;
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Sends a batch of pushes. Returns one ticket per input message, in the
 * same order as `messages` (undefined for a message whose whole batch
 * request failed at the HTTP level) — the caller needs each ticket's `id`
 * to check delivery receipts later (see checkExpoPushReceipts below); a
 * ticket alone only means Expo accepted the message into its own queue,
 * not that it ever reached the device.
 */
export async function sendExpoPushNotifications(
  messages: ExpoPushMessage[],
  accessToken?: string
): Promise<Array<ExpoPushTicket | undefined>> {
  const results: Array<ExpoPushTicket | undefined> = new Array(messages.length).fill(undefined);
  if (messages.length === 0) return results;

  const chunks = chunk(messages, BATCH_SIZE);
  let offset = 0;
  for (const batch of chunks) {
    // Full outgoing payload, so a mismatched field (categoryId, channelId,
    // whatever's next) shows up in `supabase functions logs
    // notification-scheduler` instead of being guessed at.
    console.log("Expo push request", JSON.stringify(batch));

    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "accept-encoding": "gzip, deflate",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(batch),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      console.error("Expo push send failed", res.status, bodyText);
      offset += batch.length;
      continue;
    }

    // A 200 here only means Expo accepted the HTTP request — each message
    // gets its own ticket, and a per-message problem (bad token, rejected
    // field, etc.) shows up as status: "error" on that ticket, not as an
    // HTTP failure. A ticket status of "ok" still isn't proof of delivery
    // to the device — only a subsequent receipt check tells you that.
    let parsed: { data?: ExpoPushTicket[] } | undefined;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      console.error("Expo push response was not valid JSON", bodyText);
      offset += batch.length;
      continue;
    }
    (parsed?.data ?? []).forEach((ticket, i) => {
      if (ticket.status === "error") {
        console.error("Expo push ticket error", { message: batch[i]?.to, ticket });
      } else {
        console.log("Expo push ticket ok (queued, not yet a delivery confirmation)", {
          message: batch[i]?.to,
          id: ticket.id,
        });
      }
      results[offset + i] = ticket;
    });
    offset += batch.length;
  }

  return results;
}

interface ExpoPushReceipt {
  status: "ok" | "error";
  message?: string;
  details?: { error?: string; [key: string]: unknown };
}

/**
 * Checks delivery receipts for previously sent tickets. Expo recommends
 * waiting a bit after sending before checking (their queue processes
 * asynchronously) and receipts expire after roughly a day — see the
 * caller (sweepReceipts in notification-scheduler/index.ts) for the
 * actual timing window used.
 */
export async function checkExpoPushReceipts(
  ticketIds: string[],
  accessToken?: string
): Promise<Record<string, ExpoPushReceipt>> {
  if (ticketIds.length === 0) return {};
  const result: Record<string, ExpoPushReceipt> = {};
  for (const batch of chunk(ticketIds, BATCH_SIZE)) {
    const res = await fetch(EXPO_RECEIPTS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ ids: batch }),
    });
    if (!res.ok) {
      console.error("Expo getReceipts failed", res.status, await res.text());
      continue;
    }
    const parsed = (await res.json()) as { data?: Record<string, ExpoPushReceipt> };
    Object.assign(result, parsed?.data ?? {});
  }
  return result;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
