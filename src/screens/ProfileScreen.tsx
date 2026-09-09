import React, { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { fetchUserProfile } from "../api/profile";
import { getRankProgress } from "../utils/ranks";
import { ErrorText, Heading, MetaText, ProgressBar, ScreenContainer } from "../components/ui";
import { colors } from "../theme/colors";
import { fonts } from "../theme/typography";
import type { AppStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<AppStackParamList, "Profile">;

export default function ProfileScreen({ navigation }: Props) {
  const [totalPoints, setTotalPoints] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const profile = await fetchUserProfile();
      setTotalPoints(profile.totalPoints);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load profile.");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const progress = totalPoints !== null ? getRankProgress(totalPoints) : null;

  return (
    <ScreenContainer>
      <View style={styles.header}>
        <View>
          <MetaText>FORM CH-04 · STANDING</MetaText>
          <Heading>Your rank</Heading>
        </View>
        <Pressable onPress={() => navigation.goBack()}>
          <Text style={styles.backLink}>Back</Text>
        </Pressable>
      </View>

      <ErrorText>{error}</ErrorText>

      <ScrollView
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
        contentContainerStyle={styles.content}
      >
        {progress && totalPoints !== null ? (
          <View style={styles.card}>
            <Text style={styles.rankName}>{progress.currentRank}</Text>
            <Text style={styles.points}>{totalPoints.toLocaleString()} pts</Text>

            {progress.isMaxRank ? (
              <Text style={styles.maxRank}>Partner — top rank achieved</Text>
            ) : (
              <View style={styles.progressSection}>
                <ProgressBar fraction={progress.progressFraction} />
                <Text style={styles.progressLabel}>
                  {progress.pointsIntoCurrent.toLocaleString()} /{" "}
                  {progress.pointsSpanToNext?.toLocaleString()} to {progress.nextRank}
                </Text>
              </View>
            )}
          </View>
        ) : !loading ? (
          <Text style={styles.empty}>Nothing to show yet.</Text>
        ) : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  backLink: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: "600",
  },
  content: {
    marginTop: 12,
    paddingBottom: 24,
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
  },
  rankName: {
    fontFamily: fonts.heading,
    fontSize: 24,
    color: colors.ink,
    marginBottom: 4,
  },
  points: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.inkFaded,
    marginBottom: 18,
  },
  maxRank: {
    fontFamily: fonts.body,
    fontSize: 15,
    color: colors.sage,
    fontWeight: "700",
  },
  progressSection: {
    gap: 8,
  },
  progressLabel: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.inkFaded,
  },
  empty: {
    textAlign: "center",
    color: colors.inkFaded,
    marginTop: 40,
  },
});
