import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, statusColor } from "../theme/colors";
import { fonts } from "../theme/typography";
import type { TaskWithInstance } from "../types/database";

function formatDueAt(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function TaskCard({
  task,
  onPress,
  onToggleComplete,
  onDelete,
}: {
  task: TaskWithInstance;
  onPress: () => void;
  onToggleComplete: () => void;
  onDelete: () => void;
}) {
  const { instance } = task;
  const isCompleted = instance.status === "completed";

  return (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={[styles.stamp, { borderColor: statusColor[instance.status] }]}>
        <Text style={[styles.stampText, { color: statusColor[instance.status] }]}>
          {instance.status.toUpperCase()}
        </Text>
      </View>

      <Text style={[styles.title, isCompleted && styles.titleCompleted]}>{task.title}</Text>

      <View style={styles.metaRow}>
        <Text style={styles.meta}>
          {task.type === "recurring" ? `RECURRING · ${task.recurrence_rule}` : "ONE-OFF"}
        </Text>
        <Text style={styles.meta}>DUE {formatDueAt(instance.due_at)}</Text>
      </View>
      <View style={styles.metaRow}>
        <Text style={styles.meta}>DIFFICULTY: {task.difficulty.toUpperCase()}</Text>
        <Text style={styles.meta}>CHURLESS LVL {task.churless_level}</Text>
      </View>

      <View style={styles.actionsRow}>
        <Pressable onPress={onToggleComplete} style={styles.actionButton}>
          <Text style={styles.actionText}>{isCompleted ? "Mark active" : "Mark complete"}</Text>
        </Pressable>
        <Pressable onPress={onDelete} style={styles.actionButton}>
          <Text style={[styles.actionText, styles.deleteText]}>Delete</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 12,
  },
  stamp: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderRadius: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginBottom: 8,
    transform: [{ rotate: "-2deg" }],
  },
  stampText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
  },
  title: {
    fontFamily: fonts.body,
    fontSize: 17,
    fontWeight: "600",
    color: colors.ink,
    marginBottom: 6,
  },
  titleCompleted: {
    textDecorationLine: "line-through",
    color: colors.inkFaded,
  },
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 2,
  },
  meta: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.inkFaded,
  },
  actionsRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 10,
    gap: 16,
  },
  actionButton: {
    paddingVertical: 4,
  },
  actionText: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.sage,
    fontWeight: "600",
  },
  deleteText: {
    color: colors.stampRed,
  },
});
