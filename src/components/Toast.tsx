import React, { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { setToastListener } from "../lib/toast";
import { colors } from "../theme/colors";
import { fonts } from "../theme/typography";

const VISIBLE_MS = 2200;

/** Mount once near the app root. Renders whatever showToast() last sent. */
export default function Toast() {
  const insets = useSafeAreaInsets();
  const [message, setMessage] = useState<string | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setToastListener((next) => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setMessage(next);
      Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
      hideTimer.current = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(() =>
          setMessage(null)
        );
      }, VISIBLE_MS);
    });
    return () => {
      setToastListener(null);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [opacity]);

  if (!message) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.toast, { opacity, bottom: insets.bottom + 24 }]}
    >
      <Text style={styles.text}>{message}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: "absolute",
    left: 24,
    right: 24,
    alignItems: "center",
    backgroundColor: colors.ink,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  text: {
    fontFamily: fonts.body,
    color: colors.white,
    fontSize: 15,
    fontWeight: "700",
  },
});
