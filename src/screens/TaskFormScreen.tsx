import React, { useEffect, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { createTask, deleteTask, fetchTaskWithInstance, updateTask } from "../api/tasks";
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
import { colors } from "../theme/colors";
import { computeFirstDueDate, RECURRENCE_RULES, type RecurrenceRule } from "../utils/recurrence";
import { formatDatePart, formatTimePart, parseDateAndTime, parseTimeOnly } from "../utils/dateInput";
import type { AppStackParamList } from "../navigation/types";
import type { TaskDifficulty, TaskType } from "../types/database";

type Props = NativeStackScreenProps<AppStackParamList, "TaskForm">;

const DIFFICULTIES: { label: string; value: TaskDifficulty }[] = [
  { label: "Easy", value: "easy" },
  { label: "Medium", value: "medium" },
  { label: "Hard", value: "hard" },
];

const TYPES: { label: string; value: TaskType }[] = [
  { label: "One-off", value: "custom" },
  { label: "Recurring", value: "recurring" },
];

const RECURRENCE_OPTIONS: { label: string; value: RecurrenceRule }[] = RECURRENCE_RULES.map(
  (rule) => ({ label: rule[0].toUpperCase() + rule.slice(1), value: rule })
);

const HAS_DEADLINE_OPTIONS: { label: string; value: "yes" | "no" }[] = [
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
];

function defaultDueDate(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

export default function TaskFormScreen({ navigation, route }: Props) {
  const editing = route.params !== undefined;
  const { taskId, instanceId } = route.params ?? {};

  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [type, setType] = useState<TaskType>("custom");
  const [difficulty, setDifficulty] = useState<TaskDifficulty>("medium");
  const [churlessLevel, setChurlessLevel] = useState(3);
  const [recurrenceRule, setRecurrenceRule] = useState<RecurrenceRule>("daily");
  const [hasDeadline, setHasDeadline] = useState(true);
  const [datePart, setDatePart] = useState(formatDatePart(defaultDueDate()));
  const [timePart, setTimePart] = useState(formatTimePart(defaultDueDate()));

  useEffect(() => {
    if (!editing || !taskId || !instanceId) return;
    (async () => {
      try {
        const task = await fetchTaskWithInstance(taskId, instanceId);
        setTitle(task.title);
        setType(task.type);
        setDifficulty(task.difficulty);
        setChurlessLevel(task.churless_level);
        if (task.recurrence_rule) setRecurrenceRule(task.recurrence_rule as RecurrenceRule);
        setHasDeadline(task.has_deadline);
        if (task.instance.due_at) {
          const due = new Date(task.instance.due_at);
          setDatePart(formatDatePart(due));
          setTimePart(formatTimePart(due));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load task.");
      } finally {
        setLoading(false);
      }
    })();
  }, [editing, taskId, instanceId]);

  const adjustChurlessLevel = (delta: number) => {
    setChurlessLevel((prev) => Math.min(10, Math.max(1, prev + delta)));
  };

  const handleSubmit = async () => {
    setError(null);
    if (!title.trim()) {
      setError("Give the task a title.");
      return;
    }

    let dueAt: Date | null;
    if (type === "custom" && !hasDeadline) {
      // No-deadline custom task: nagging starts from creation time instead
      // (see supabase/migrations/0008_no_deadline_tasks.sql), so there's no
      // due date/time to collect at all.
      dueAt = null;
    } else if (type === "recurring" && !editing) {
      // New recurring task: only a time of day was asked for (no date
      // field shown) — pick the first occurrence of that time per the
      // recurrence rule, starting from now.
      const timeOfDay = parseTimeOnly(timePart);
      dueAt = timeOfDay ? computeFirstDueDate(recurrenceRule, timeOfDay, new Date()) : null;
      if (!dueAt) {
        setError("Enter a valid time (HH:MM).");
        return;
      }
    } else {
      // Custom tasks with a deadline, and editing an existing recurring
      // instance (whose calendar date came from the loaded instance, not
      // user input), still use the full date+time.
      dueAt = parseDateAndTime(datePart, timePart);
      if (!dueAt) {
        setError("Enter a valid due date (YYYY-MM-DD) and time (HH:MM).");
        return;
      }
    }

    setSaving(true);
    try {
      if (editing && taskId && instanceId) {
        await updateTask(
          taskId,
          instanceId,
          { title, difficulty, churlessLevel, recurrenceRule, hasDeadline, dueAt },
          type
        );
      } else {
        await createTask({
          title,
          type,
          difficulty,
          churlessLevel,
          recurrenceRule: type === "recurring" ? recurrenceRule : null,
          hasDeadline,
          dueAt,
        });
      }
      navigation.goBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save task.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    if (!taskId) return;
    Alert.alert("Delete task", `Delete "${title}"? This can't be undone.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteTask(taskId);
            navigation.goBack();
          } catch (e) {
            Alert.alert("Error", e instanceof Error ? e.message : "Something went wrong.");
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <ScreenContainer>
        <MetaText>Loading…</MetaText>
      </ScreenContainer>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
        <ScreenContainer>
          <MetaText>FORM CH-04 · {editing ? "AMEND TASK" : "NEW TASK"}</MetaText>
          <Heading>{editing ? "Edit task" : "New task"}</Heading>
          <ErrorText>{error}</ErrorText>

          <LabeledInput label="Title" value={title} onChangeText={setTitle} placeholder="File the TPS report" />

          <View style={{ marginBottom: 14 }}>
            <MetaText>TYPE</MetaText>
            {editing ? (
              <Text style={styles.readOnlyValue}>
                {type === "recurring" ? "Recurring" : "One-off"} (fixed at creation)
              </Text>
            ) : (
              <View style={{ marginTop: 4 }}>
                <SegmentedControl options={TYPES} value={type} onChange={setType} />
              </View>
            )}
          </View>

          <View style={{ marginBottom: 14 }}>
            <MetaText>DIFFICULTY</MetaText>
            <View style={{ marginTop: 4 }}>
              <SegmentedControl options={DIFFICULTIES} value={difficulty} onChange={setDifficulty} />
            </View>
          </View>

          {type === "recurring" && (
            <View style={{ marginBottom: 14 }}>
              <MetaText>RECURS</MetaText>
              <View style={{ marginTop: 4 }}>
                <SegmentedControl
                  options={RECURRENCE_OPTIONS}
                  value={recurrenceRule}
                  onChange={setRecurrenceRule}
                />
              </View>
            </View>
          )}

          <View style={{ marginBottom: 14 }}>
            <MetaText>CHURLESS LEVEL (1-10)</MetaText>
            <View style={styles.stepperRow}>
              <SecondaryButton title="-" onPress={() => adjustChurlessLevel(-1)} />
              <Text style={styles.stepperValue}>{churlessLevel}</Text>
              <SecondaryButton title="+" onPress={() => adjustChurlessLevel(1)} />
            </View>
          </View>

          {type === "custom" && (
            <View style={{ marginBottom: 14 }}>
              <MetaText>HAS A HARD DEADLINE?</MetaText>
              <View style={{ marginTop: 4 }}>
                <SegmentedControl
                  options={HAS_DEADLINE_OPTIONS}
                  value={hasDeadline ? "yes" : "no"}
                  onChange={(value) => setHasDeadline(value === "yes")}
                />
              </View>
            </View>
          )}

          {type === "custom" ? (
            hasDeadline && (
              <View style={styles.dateRow}>
                <View style={{ flex: 1, marginRight: 8 }}>
                  <LabeledInput
                    label="Due date"
                    value={datePart}
                    onChangeText={setDatePart}
                    placeholder="YYYY-MM-DD"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <LabeledInput
                    label="Due time"
                    value={timePart}
                    onChangeText={setTimePart}
                    placeholder="HH:MM"
                  />
                </View>
              </View>
            )
          ) : (
            // Recurring tasks are defined by a time of day + a recurrence
            // pattern, not a calendar date — individual instances are
            // generated going forward from that (see computeFirstDueDate).
            <LabeledInput label="Time" value={timePart} onChangeText={setTimePart} placeholder="HH:MM" />
          )}

          <PrimaryButton
            title={editing ? "Save changes" : "Create task"}
            onPress={handleSubmit}
            loading={saving}
          />

          {editing && <SecondaryButton title="Delete task" onPress={handleDelete} />}
        </ScreenContainer>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = {
  readOnlyValue: {
    fontFamily: "System",
    color: colors.inkFaded,
    marginTop: 4,
  },
  stepperRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 16,
    marginTop: 4,
  },
  stepperValue: {
    fontSize: 18,
    fontWeight: "700" as const,
    color: colors.ink,
    minWidth: 24,
    textAlign: "center" as const,
  },
  dateRow: {
    flexDirection: "row" as const,
  },
};
