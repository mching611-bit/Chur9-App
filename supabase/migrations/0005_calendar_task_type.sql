-- Chur9 M3 schema accounting: the build brief calls out that calendar-
-- sourced tasks (M4, not yet built) will score the same as 'custom' once a
-- user opts an event into Churless treatment. Adding the enum value now so
-- a later migration doesn't have to touch task_type at all.
--
-- Split into its own file/transaction on purpose: Postgres won't let a
-- newly added enum value be referenced by other DDL (e.g. a CHECK
-- constraint literal) until the transaction that added it has committed.
-- See 0006_points_scoring.sql, which does reference it.

alter type public.task_type add value 'calendar';
