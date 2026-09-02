import { Platform } from "react-native";

// M1 sticks to system-available font families (no custom font loading yet)
// so the memo/HR-paperwork feel can be dialed in later without blocking CRUD.
export const fonts = {
  heading: Platform.select({ ios: "Georgia", android: "serif", default: "Georgia, serif" }),
  body: Platform.select({ ios: "System", android: "sans-serif", default: "System" }),
  mono: Platform.select({
    ios: "Courier New",
    android: "monospace",
    default: "Courier New, monospace",
  }),
} as const;
