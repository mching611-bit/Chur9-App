// Client side of the M2 notification engine: permissions, the Expo push
// token, the Done/Snooze action-button category, and wiring notification
// responses back into src/api/notifications.ts. The actual scheduling
// (when to nag, quiet hours, escalation) lives server-side in
// supabase/functions/notification-scheduler — this file only registers the
// device and reacts to what the user does with a notification once it
// arrives.
//
// NOTE (read before testing): Expo Go on Android no longer supports
// receiving remote push notifications (removed from Expo Go; see
// supabase/README.md). Use a development build
// (`expo-dev-client` / `eas build --profile development`) for real
// end-to-end verification — Expo Go is only useful here for exercising the
// permission/category/local-notification plumbing.
//
// The push the server sends is data-only (no top-level title/body) — see
// supabase/functions/notification-scheduler/index.ts. On Android, a push
// that DOES have a title/body gets auto-displayed by Google Play Services'
// own FCM SDK before this app's code ever runs, which was the actual cause
// of the Done/Snooze buttons never appearing: that auto-built system
// notification has no idea a "task_reminder" category exists. A data-only
// message instead always reaches this file's code (foreground: the
// received listener below; background/killed: the TaskManager task below),
// which builds and presents the notification itself via
// scheduleNotificationAsync, with the category attached correctly.

import * as Device from "expo-device";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { recordNotificationAction, savePushToken } from "../api/notifications";
import type { NotificationAction } from "../types/database";

export const TASK_REMINDER_CATEGORY = "task_reminder";
const BACKGROUND_NOTIFICATION_TASK = "chur9-background-notification-task";

/** Data payload every reminder push carries (see notification-scheduler/index.ts). */
interface ReminderData {
  notificationId?: string;
  taskInstanceId?: string;
  taskId?: string;
  title?: string;
  body?: string;
}

/** Builds and shows the actual system notification from a reminder push's data, category attached. */
async function presentReminderNotification(data: ReminderData): Promise<void> {
  if (!data?.notificationId) return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: data.title ?? "Chur9",
      body: data.body ?? "",
      data: { notificationId: data.notificationId, taskInstanceId: data.taskInstanceId, taskId: data.taskId },
      categoryIdentifier: TASK_REMINDER_CATEGORY,
      sound: "default",
    },
    trigger: Platform.OS === "android" ? { channelId: "default" } : null,
  });
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function registerNotificationCategoriesAsync(): Promise<void> {
  try {
    await Notifications.setNotificationCategoryAsync(TASK_REMINDER_CATEGORY, [
      {
        identifier: "done",
        buttonTitle: "Done",
        options: { opensAppToForeground: false },
      },
      {
        identifier: "snooze_30",
        buttonTitle: "Snooze 30 min",
        options: { opensAppToForeground: false },
      },
      {
        identifier: "snooze_2hr",
        buttonTitle: "Snooze 2 hrs",
        options: { opensAppToForeground: false },
      },
    ]);
    // Read the registration back rather than trusting the call above
    // resolved cleanly — this was previously fire-and-forget from App.tsx
    // (no await, no .catch), so a failure here would otherwise be a
    // silent no-op with no visible symptom other than "no action buttons."
    const registered = await Notifications.getNotificationCategoriesAsync();
    const found = registered.find((c) => c.identifier === TASK_REMINDER_CATEGORY);
    if (!found) {
      console.error(
        `Category "${TASK_REMINDER_CATEGORY}" not present after registration`,
        registered.map((c) => c.identifier)
      );
    } else {
      console.log(
        `Category "${TASK_REMINDER_CATEGORY}" registered with actions`,
        found.actions.map((a) => a.identifier)
      );
    }
  } catch (err) {
    console.error("Failed to register notification categories", err);
  }
}

/**
 * Requests permission (if needed) and saves the device's Expo push token to
 * the signed-in user's row. Safe to call every time the app foregrounds —
 * it's a no-op once permission and the token are already in place.
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (!Device.isDevice) {
    console.warn("Push notifications require a physical device.");
    return null;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== "granted") {
    console.warn("Push notification permission not granted.");
    return null;
  }

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Task reminders",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) {
    console.warn(
      "Missing extra.eas.projectId in app.json — run `eas init` to link the project before push tokens can be issued."
    );
    return null;
  }

  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  await savePushToken(token);
  return token;
}

/** Routes a tapped action (or a foreground tap with no action = treat as "opened") back to the API. */
async function handleNotificationResponse(response: Notifications.NotificationResponse): Promise<void> {
  const data = response.notification.request.content.data as ReminderData;
  if (!data?.notificationId) return;

  const actionIdentifier = response.actionIdentifier;
  const action: NotificationAction | null =
    actionIdentifier === "done" || actionIdentifier === "snooze_30" || actionIdentifier === "snooze_2hr"
      ? actionIdentifier
      : null;

  // A plain tap (Notifications.DEFAULT_ACTION_IDENTIFIER) opens the app to
  // the task instead of recording an action — only the three buttons above
  // count as a response for escalation/send-time-learning purposes.
  if (!action) return;

  try {
    await recordNotificationAction(data.notificationId, action);
  } catch (err) {
    console.error("Failed to record notification action", err);
  }
}

/** Call once near app startup. Wires the foreground listeners and the Android background task. */
export function setupNotificationResponseHandling(): () => void {
  const responseSubscription = Notifications.addNotificationResponseReceivedListener(
    handleNotificationResponse
  );

  // Fires when a push arrives while the JS runtime is already up (app in
  // foreground). Since our push is data-only, nothing gets auto-displayed —
  // this is the one place responsible for actually showing it, matching
  // the plain-received branch of the background task below.
  const receivedSubscription = Notifications.addNotificationReceivedListener((notification) => {
    void presentReminderNotification(notification.request.content.data as ReminderData);
  });

  // Covers the case where the app was killed and an action button launched
  // it: the response that caused the cold start doesn't replay through the
  // listener above, so check for it explicitly once.
  Notifications.getLastNotificationResponseAsync().then((response) => {
    if (response) handleNotificationResponse(response);
  });

  return () => {
    responseSubscription.remove();
    receivedSubscription.remove();
  };
}

if (!TaskManager.isTaskDefined(BACKGROUND_NOTIFICATION_TASK)) {
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(
    BACKGROUND_NOTIFICATION_TASK,
    async ({ data, error }) => {
      if (error) {
        console.error("Background notification task error", error);
        return;
      }
      if (!data) return;

      if ("actionIdentifier" in data) {
        // A Done/Snooze tap (or a plain tap) while backgrounded/killed —
        // `data` here already *is* the NotificationResponse.
        await handleNotificationResponse(data);
        return;
      }

      // Plain delivery, no user interaction yet — app was backgrounded or
      // killed when the push arrived. `data.data.dataString` carries our
      // custom payload as a JSON string (see NotificationTaskPayload).
      try {
        const parsed = data.data.dataString ? JSON.parse(data.data.dataString) : data.data;
        await presentReminderNotification(parsed as ReminderData);
      } catch (err) {
        console.error("Failed to present reminder from background task", err);
      }
    }
  );
}

/**
 * Registers the background task so a backgrounded/killed app can still
 * present a reminder (and, on Android, record a Done/Snooze tap directly)
 * without the JS runtime already running. Needed on both platforms now
 * that the push itself is silent/data-only everywhere — a regular push
 * used to get auto-displayed by the OS on its own, a silent one won't.
 * iOS action-tap handling specifically (as opposed to plain delivery)
 * still isn't caught by this task while backgrounded/killed per Expo's
 * docs — that path is limited to the foreground/cold-start listeners
 * above — consistent with the brief treating iOS as best-effort until the
 * Apple Developer account is active.
 */
export async function registerBackgroundNotificationTaskAsync(): Promise<void> {
  try {
    await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
  } catch (err) {
    console.error("Failed to register background notification task", err);
  }
}
