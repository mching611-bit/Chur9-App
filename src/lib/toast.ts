// Minimal cross-cutting toast bus. Needed because "show points earned" has
// to be triggerable both from a screen (Mark complete button) and from
// src/api/notifications.ts (the notification's Done action), which isn't a
// component and can't use React state/context directly.

type ToastListener = (message: string) => void;

let listener: ToastListener | null = null;

/** Called once by the <Toast /> host mounted near the app root. */
export function setToastListener(next: ToastListener | null): void {
  listener = next;
}

export function showToast(message: string): void {
  listener?.(message);
}
