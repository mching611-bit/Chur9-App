import "react-native-gesture-handler";
import React, { useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AuthProvider } from "./src/contexts/AuthContext";
import RootNavigator from "./src/navigation/RootNavigator";
import {
  registerBackgroundNotificationTaskAsync,
  registerNotificationCategoriesAsync,
  setupNotificationResponseHandling,
} from "./src/lib/pushNotifications";

export default function App() {
  useEffect(() => {
    // Device-level setup that doesn't depend on being signed in yet; the
    // push token itself is registered once a session exists (see
    // RootNavigator's AppNavigator).
    registerNotificationCategoriesAsync();
    registerBackgroundNotificationTaskAsync();
    const teardown = setupNotificationResponseHandling();
    return teardown;
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <RootNavigator />
        </AuthProvider>
        <StatusBar style="auto" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
