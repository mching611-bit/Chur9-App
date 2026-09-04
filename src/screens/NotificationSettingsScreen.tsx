import React, { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  fetchNotificationPreferences,
  updateNotificationPreferences,
} from "../api/notifications";
import { registerForPushNotificationsAsync } from "../lib/pushNotifications";
import {
  ErrorText,
  Heading,
  LabeledInput,
  MetaText,
  PrimaryButton,
  ScreenContainer,
  SecondaryButton,
  SegmentedControl,
} from "../components/ui";
import type { AppStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<AppStackParamList, "NotificationSettings">;

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

const EMAIL_OPTIONS = [
  { label: "Off", value: "off" as const },
  { label: "On", value: "on" as const },
];

export default function NotificationSettingsScreen({ navigation }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [quietStart, setQuietStart] = useState("");
  const [quietEnd, setQuietEnd] = useState("");
  const [emailOptIn, setEmailOptIn] = useState<"on" | "off">("off");
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [registeringPush, setRegisteringPush] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const prefs = await fetchNotificationPreferences();
        setQuietStart(prefs.quiet_hours_start?.slice(0, 5) ?? "");
        setQuietEnd(prefs.quiet_hours_end?.slice(0, 5) ?? "");
        setEmailOptIn(prefs.email_opt_in ? "on" : "off");
        setPushToken(prefs.push_token);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load notification settings.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleEnablePush = async () => {
    setRegisteringPush(true);
    try {
      const token = await registerForPushNotificationsAsync();
      if (token) {
        setPushToken(token);
      } else {
        Alert.alert(
          "Couldn't enable push",
          "Permission wasn't granted, or this build isn't linked to an EAS project yet."
        );
      }
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setRegisteringPush(false);
    }
  };

  const handleSave = async () => {
    setError(null);
    const startTrimmed = quietStart.trim();
    const endTrimmed = quietEnd.trim();
    if ((startTrimmed && !endTrimmed) || (!startTrimmed && endTrimmed)) {
      setError("Set both a quiet hours start and end, or leave both blank.");
      return;
    }
    if (startTrimmed && !TIME_RE.test(startTrimmed)) {
      setError("Quiet hours start must be HH:MM (24-hour).");
      return;
    }
    if (endTrimmed && !TIME_RE.test(endTrimmed)) {
      setError("Quiet hours end must be HH:MM (24-hour).");
      return;
    }

    setSaving(true);
    try {
      await updateNotificationPreferences({
        quietHoursStart: startTrimmed || null,
        quietHoursEnd: endTrimmed || null,
        emailOptIn: emailOptIn === "on",
      });
      navigation.goBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <ScreenContainer>
        <MetaText>Loading…</MetaText>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      <MetaText>FORM CH-07 · NOTIFICATION PREFS</MetaText>
      <Heading>Notifications</Heading>
      <ErrorText>{error}</ErrorText>

      <View style={{ marginBottom: 14 }}>
        <MetaText>PUSH NOTIFICATIONS</MetaText>
        <View style={{ marginTop: 6 }}>
          <MetaText>{pushToken ? "Enabled on this device." : "Not enabled on this device."}</MetaText>
          <SecondaryButton
            title={pushToken ? "Re-register this device" : "Enable push notifications"}
            onPress={handleEnablePush}
          />
        </View>
      </View>

      <View style={styles.dateRow}>
        <View style={{ flex: 1, marginRight: 8 }}>
          <LabeledInput
            label="Quiet hours start"
            value={quietStart}
            onChangeText={setQuietStart}
            placeholder="HH:MM"
          />
        </View>
        <View style={{ flex: 1 }}>
          <LabeledInput
            label="Quiet hours end"
            value={quietEnd}
            onChangeText={setQuietEnd}
            placeholder="HH:MM"
          />
        </View>
      </View>
      <MetaText>Nags due during this window get pushed to a random time after it ends.</MetaText>

      <View style={{ marginTop: 14, marginBottom: 14 }}>
        <MetaText>EMAIL BACKUP (sent once a nag goes unanswered)</MetaText>
        <View style={{ marginTop: 4 }}>
          <SegmentedControl options={EMAIL_OPTIONS} value={emailOptIn} onChange={setEmailOptIn} />
        </View>
      </View>

      <PrimaryButton title="Save" onPress={handleSave} loading={saving || registeringPush} />
    </ScreenContainer>
  );
}

const styles = {
  dateRow: {
    flexDirection: "row" as const,
    marginTop: 14,
  },
};
