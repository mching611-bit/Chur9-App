import "react-native-gesture-handler";
import React, { useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AuthProvider } from "./src/contexts/AuthContext";
import RootNavigator from "./src/navigation/RootNavigator";
import Toast from "./src/components/Toast";
import {
  registerBackgroundNotificationTaskAsync,
  registerNotificationCategoriesAsync,
  setupNotificationResponseHandling,
} from "./src/lib/pushNotifications";
import { setupAuthDeepLinkHandling } from "./src/lib/authDeepLink";

export default function App() {
  useEffect(() => {
    // Device-level setup that doesn't depend on being signed in yet; the
    // push token itself is registered once a session exists (see
    // RootNavigator's AppNavigator).
    // registerNotificationCategoriesAsync handles/logs its own errors
    // internally (see src/lib/pushNotifications.ts) rather than rejecting.
    registerNotificationCategoriesAsync();
    registerBackgroundNotificationTaskAsync();
    const teardown = setupNotificationResponseHandling();
    return teardown;
  }, []);

  useEffect(() => {
    // Catches the confirmation-email deep link (both cold-start and while
    // already running) and completes the Supabase session from it — see
    // src/lib/authDeepLink.ts.
    return setupAuthDeepLinkHandling();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <RootNavigator />
          <Toast />
        </AuthProvider>
        <StatusBar style="auto" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
