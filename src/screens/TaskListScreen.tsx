import React, { useCallback, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { completeTaskInstance, deleteTask, fetchTasksWithInstances, reopenTaskInstance } from "../api/tasks";
import { useAuth } from "../contexts/AuthContext";
import TaskCard from "../components/TaskCard";
import { Heading, MetaText, ScreenContainer, SegmentedControl } from "../components/ui";
import { colors } from "../theme/colors";
import type { AppStackParamList } from "../navigation/types";
import type { TaskInstanceStatus, TaskWithInstance } from "../types/database";

type Props = NativeStackScreenProps<AppStackParamList, "TaskList">;

const TABS: { label: string; value: TaskInstanceStatus }[] = [
  { label: "Active", value: "active" },
  { label: "Overdue", value: "overdue" },
  { label: "Completed", value: "completed" },
];

export default function TaskListScreen({ navigation }: Props) {
  const { signOut } = useAuth();
  const [tab, setTab] = useState<TaskInstanceStatus>("active");
  const [tasks, setTasks] = useState<TaskWithInstance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (status: TaskInstanceStatus) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchTasksWithInstances(status);
      setTasks(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tasks.");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load(tab);
    }, [load, tab])
  );

  const handleToggleComplete = async (item: TaskWithInstance) => {
    try {
      if (item.instance.status === "completed") {
        await reopenTaskInstance(item.instance.id);
      } else {
        // completeTaskInstance still returns points awarded (scoring keeps
        // running server-side), but the points/rank UI is shelved for now —
        // see src/screens/TaskListScreen.tsx's header comment.
        await completeTaskInstance(item, item.instance);
      }
      load(tab);
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Something went wrong.");
    }
  };

  const handleDelete = (item: TaskWithInstance) => {
    Alert.alert("Delete task", `Delete "${item.title}"? This can't be undone.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteTask(item.id);
            load(tab);
          } catch (e) {
            Alert.alert("Error", e instanceof Error ? e.message : "Something went wrong.");
          }
        },
      },
    ]);
  };

  return (
    <ScreenContainer>
      <View style={styles.header}>
        <View>
          <MetaText>FORM CH-03 · TASK LOG</MetaText>
          <Heading>Your tasks</Heading>
        </View>
        <View style={styles.headerActions}>
          {/* Profile (points/rank) link intentionally hidden; scoring still
              runs server-side, just not surfaced in the UI right now. */}
          <Pressable onPress={() => navigation.navigate("NotificationSettings")}>
            <Text style={styles.headerLink}>Notifications</Text>
          </Pressable>
          <Pressable onPress={signOut}>
            <Text style={styles.signOut}>Sign out</Text>
          </Pressable>
        </View>
      </View>

      <SegmentedControl options={TABS} value={tab} onChange={setTab} />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        style={styles.list}
        data={tasks}
        keyExtractor={(item) => item.instance.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(tab)} />}
        ListEmptyComponent={
          !loading ? (
            <Text style={styles.empty}>No {tab} tasks. Enjoy the quiet.</Text>
          ) : null
        }
        renderItem={({ item }) => (
          <TaskCard
            task={item}
            onPress={() =>
              navigation.navigate("TaskForm", { taskId: item.id, instanceId: item.instance.id })
            }
            onToggleComplete={() => handleToggleComplete(item)}
            onDelete={() => handleDelete(item)}
          />
        )}
      />

      <Pressable style={styles.fab} onPress={() => navigation.navigate("TaskForm")}>
        <Text style={styles.fabText}>+ New task</Text>
      </Pressable>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  headerLink: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: "600",
  },
  signOut: {
    color: colors.stampRed,
    fontSize: 13,
    fontWeight: "600",
  },
  list: {
    marginTop: 12,
    flex: 1,
  },
  empty: {
    textAlign: "center",
    color: colors.inkFaded,
    marginTop: 40,
  },
  error: {
    color: colors.stampRed,
    marginTop: 8,
  },
  fab: {
    backgroundColor: colors.ink,
    borderRadius: 24,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  fabText: {
    color: colors.white,
    fontWeight: "700",
    fontSize: 15,
  },
});
