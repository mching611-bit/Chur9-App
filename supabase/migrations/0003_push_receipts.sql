-- Chur9 M2 follow-up: track Expo push delivery receipts.
--
-- A "ticket" (returned immediately from the Expo Push API send call) only
-- means Expo accepted the message into their own queue — not that FCM/APNs
-- or the device ever got it. Confirming that requires a second call
-- (getReceipts) some time after sending. Without this, a push that Expo
-- silently failed to hand off to FCM (bad/expired credentials, an
-- unregistered device token, rate limiting, etc.) looks identical, from our
-- side, to one the device just didn't present — indistinguishable without
-- a live on-device logcat capture every time. See supabase/README.md.

alter table public.notifications
  add column expo_ticket_id text,
  add column receipt_checked_at timestamptz,
  add column expo_receipt_error text;

create index notifications_pending_receipt_idx on public.notifications (sent_at)
  where channel = 'push' and expo_ticket_id is not null and receipt_checked_at is null;
