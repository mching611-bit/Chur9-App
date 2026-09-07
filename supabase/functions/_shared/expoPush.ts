// Sends push notifications via the Expo Push API (https://exp.host). Using
// Expo's service (rather than calling FCM/APNs directly) is what makes the
// engine platform-agnostic per the M2 brief: it fans out to Android (FCM)
// and iOS (APNs) from the same call, keyed only by each device's Expo push
// token.

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const BATCH_SIZE = 100; // Expo's documented max messages per request.

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  // Expo Push API field name for this is `categoryId`, distinct from the
  // client-side expo-notifications `categoryIdentifier` used when
  // registering the category on-device (see setNotificationCategoryAsync
  // in src/lib/pushNotifications.ts) — the value must still match that
  // registered identifier, only the wire field name differs.
  categoryId?: string;
  // Must match a channel created client-side via
  // Notifications.setNotificationChannelAsync (see
  // registerForPushNotificationsAsync in src/lib/pushNotifications.ts).
  // Not strictly required — Expo falls back to a "default" channel if
  // omitted — but explicit here so there's one less thing to guess about
  // when actions don't show up.
  channelId?: string;
  sound?: "default";
  priority?: "default" | "normal" | "high";
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export async function sendExpoPushNotifications(
  messages: ExpoPushMessage[],
  accessToken?: string
): Promise<void> {
  if (messages.length === 0) return;
  for (const batch of chunk(messages, BATCH_SIZE)) {
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
      continue;
    }

    // A 200 here only means Expo accepted the HTTP request — each message
    // gets its own ticket, and a per-message problem (bad token, rejected
    // field, etc.) shows up as status: "error" on that ticket, not as an
    // HTTP failure. Logging every ticket, not just failures, so a
    // "status: ok" here at least rules out the send step.
    let parsed: { data?: ExpoPushTicket[] } | undefined;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      console.error("Expo push response was not valid JSON", bodyText);
      continue;
    }
    (parsed?.data ?? []).forEach((ticket, i) => {
      if (ticket.status === "error") {
        console.error("Expo push ticket error", { message: batch[i]?.to, ticket });
      } else {
        console.log("Expo push ticket ok", { message: batch[i]?.to, id: ticket.id });
      }
    });
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
