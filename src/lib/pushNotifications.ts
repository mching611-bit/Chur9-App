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

/** Call once near app startup. Wires the foreground listener and the Android background action task. */
export function setupNotificationResponseHandling(): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener(handleNotificationResponse);

  // Covers the case where the app was killed and an action button launched
  // it: the response that caused the cold start doesn't replay through the
  // listener above, so check for it explicitly once.
  Notifications.getLastNotificationResponseAsync().then((response) => {
    if (response) handleNotificationResponse(response);
  });

  return () => subscription.remove();
}

if (!TaskManager.isTaskDefined(BACKGROUND_NOTIFICATION_TASK)) {
  TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }) => {
    if (error) {
      console.error("Background notification task error", error);
      return;
    }
    const response = (data as { notification?: Notifications.NotificationResponse } | undefined)
      ?.notification;
    if (response) await handleNotificationResponse(response);
  });
}

/**
 * Registers the Android background task so a Done/Snooze tap is recorded
 * even if the app process isn't already running. iOS action handling
 * without opening the app is more limited under Expo's managed workflow;
 * for now iOS actions are handled via the foreground/cold-start paths
 * above, consistent with the brief treating iOS as best-effort until the
 * Apple Developer account is active.
 */
export async function registerBackgroundNotificationTaskAsync(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
  } catch (err) {
    console.error("Failed to register background notification task", err);
  }
}
