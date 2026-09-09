import React, { useEffect } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useAuth } from "../contexts/AuthContext";
import SignInScreen from "../screens/SignInScreen";
import SignUpScreen from "../screens/SignUpScreen";
import TaskListScreen from "../screens/TaskListScreen";
import TaskFormScreen from "../screens/TaskFormScreen";
import NotificationSettingsScreen from "../screens/NotificationSettingsScreen";
import ProfileScreen from "../screens/ProfileScreen";
import { ScreenContainer, MetaText } from "../components/ui";
import { registerForPushNotificationsAsync } from "../lib/pushNotifications";
import { saveDeviceTimezone } from "../api/notifications";
import type { AppStackParamList, AuthStackParamList } from "./types";

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const AppStack = createNativeStackNavigator<AppStackParamList>();

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="SignIn" component={SignInScreen} />
      <AuthStack.Screen name="SignUp" component={SignUpScreen} />
    </AuthStack.Navigator>
  );
}

function AppNavigator() {
  useEffect(() => {
    // Best-effort: registers the device's Expo push token and local
    // timezone against the signed-in user. Failures (permission denied, no
    // EAS project linked yet) are logged but never block the app — quiet
    // hours/scheduling just won't have a real device to notify until this
    // succeeds, which the user can retry from Notification settings.
    registerForPushNotificationsAsync().catch((err) => console.warn("Push registration failed", err));
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone) {
      saveDeviceTimezone(timezone).catch((err) => console.warn("Timezone save failed", err));
    }
  }, []);

  return (
    <AppStack.Navigator screenOptions={{ headerShown: false }}>
      <AppStack.Screen name="TaskList" component={TaskListScreen} />
      <AppStack.Screen name="TaskForm" component={TaskFormScreen} />
      <AppStack.Screen name="NotificationSettings" component={NotificationSettingsScreen} />
      <AppStack.Screen name="Profile" component={ProfileScreen} />
    </AppStack.Navigator>
  );
}

export default function RootNavigator() {
  const { session, initializing } = useAuth();

  if (initializing) {
    return (
      <ScreenContainer>
        <MetaText>Loading…</MetaText>
      </ScreenContainer>
    );
  }

  return <NavigationContainer>{session ? <AppNavigator /> : <AuthNavigator />}</NavigationContainer>;
}
