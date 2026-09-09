import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../theme/colors";
import { fonts } from "../theme/typography";

export function ScreenContainer({ children }: { children: React.ReactNode }) {
  // Fixed padding alone isn't enough on devices whose safe area extends past
  // it (e.g. a front-camera cutout) — insets.top varies per device, so it
  // has to be measured rather than assumed.
  const insets = useSafeAreaInsets();
  return <View style={[styles.screen, { paddingTop: insets.top + 20 }]}>{children}</View>;
}

export function Heading({ children }: { children: React.ReactNode }) {
  return <Text style={styles.heading}>{children}</Text>;
}

export function MetaText({ children }: { children: React.ReactNode }) {
  return <Text style={styles.meta}>{children}</Text>;
}

export function ErrorText({ children }: { children: string | null }) {
  if (!children) return null;
  return <Text style={styles.error}>{children}</Text>;
}

export function LabeledInput(props: TextInputProps & { label: string }) {
  const { label, style, ...rest } = props;
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, style]}
        placeholderTextColor={colors.inkFaded}
        {...rest}
      />
    </View>
  );
}

export function PrimaryButton({
  title,
  onPress,
  loading,
  disabled,
}: {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.primaryButton,
        (disabled || loading) && styles.buttonDisabled,
        pressed && !disabled && !loading && styles.buttonPressed,
      ]}
      onPress={onPress}
      disabled={disabled || loading}
    >
      {loading ? (
        <ActivityIndicator color={colors.white} />
      ) : (
        <Text style={styles.primaryButtonText}>{title}</Text>
      )}
    </Pressable>
  );
}

export function SecondaryButton({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
      onPress={onPress}
    >
      <Text style={styles.secondaryButtonText}>{title}</Text>
    </Pressable>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.segmentRow}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            style={[styles.segment, selected && styles.segmentSelected]}
            onPress={() => onChange(opt.value)}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ProgressBar({ fraction }: { fraction: number }) {
  const clamped = Math.min(1, Math.max(0, fraction));
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${clamped * 100}%` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.kraft,
    padding: 20,
  },
  heading: {
    fontFamily: fonts.heading,
    fontSize: 28,
    color: colors.ink,
    marginBottom: 16,
  },
  meta: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.inkFaded,
    letterSpacing: 0.5,
  },
  error: {
    fontFamily: fonts.body,
    color: colors.stampRed,
    marginBottom: 8,
  },
  field: {
    marginBottom: 14,
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.inkFaded,
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  input: {
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.ink,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  primaryButton: {
    backgroundColor: colors.ink,
    borderRadius: 6,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  primaryButtonText: {
    fontFamily: fonts.body,
    color: colors.white,
    fontSize: 16,
    fontWeight: "600",
  },
  secondaryButton: {
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 8,
  },
  secondaryButtonText: {
    fontFamily: fonts.body,
    color: colors.ink,
    fontSize: 14,
    textDecorationLine: "underline",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonPressed: {
    opacity: 0.8,
  },
  segmentRow: {
    flexDirection: "row",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    overflow: "hidden",
  },
  segment: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: colors.white,
  },
  segmentSelected: {
    backgroundColor: colors.ink,
  },
  segmentText: {
    fontFamily: fonts.body,
    color: colors.ink,
    fontSize: 14,
  },
  segmentTextSelected: {
    color: colors.white,
    fontWeight: "600",
  },
  progressTrack: {
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: colors.sage,
    borderRadius: 5,
  },
});
