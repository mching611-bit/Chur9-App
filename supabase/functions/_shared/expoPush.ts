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
  categoryIdentifier?: string;
  sound?: "default";
  priority?: "default" | "normal" | "high";
}

export async function sendExpoPushNotifications(
  messages: ExpoPushMessage[],
  accessToken?: string
): Promise<void> {
  if (messages.length === 0) return;
  for (const batch of chunk(messages, BATCH_SIZE)) {
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
    if (!res.ok) {
      console.error("Expo push send failed", res.status, await res.text());
    }
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
