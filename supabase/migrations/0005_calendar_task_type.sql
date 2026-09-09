-- Chur9 M3 schema accounting: the build brief calls out that calendar-
-- sourced tasks (M4, not yet built) will score the same as 'custom' once a
-- user opts an event into Churless treatment. Adding the enum value now so
-- a later migration doesn't have to touch task_type at all.
--
-- Split into its own file/transaction on purpose: Postgres won't let a
-- newly added enum value be referenced by other DDL (e.g. a CHECK
-- constraint literal) until the transaction that added it has committed.
-- See 0006_points_scoring.sql, which does reference it.
--
-- MUST be run as its own execution, separate from 0006 — pasting both into
-- one SQL Editor "Run" sends them as a single implicit transaction, and
-- 0006's later reference to 'calendar' fails with "unsafe use of new value
-- of enum type added in this transaction", which rolls back this ALTER TYPE
-- too (verified: not just 0006 rolls back — the whole combined paste does).
--
-- IF NOT EXISTS makes this safe to re-run regardless of whether a previous
-- attempt got this far before failing elsewhere.

alter type public.task_type add value if not exists 'calendar';
