export const colors = {
  kraft: "#EDE3CC",
  ink: "#211E1A",
  stampRed: "#B23A2E",
  sage: "#5E7A55",
  brass: "#C89B3C",
  white: "#FFFFFF",
  inkFaded: "#6B665C",
  border: "#C9BC9C",
} as const;

export const statusColor: Record<"active" | "completed" | "overdue", string> = {
  active: colors.ink,
  completed: colors.sage,
  overdue: colors.stampRed,
};
