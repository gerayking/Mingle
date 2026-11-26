-- A reminder can carry a check command (docs/spec.md 4.6): Mingle runs it on the reminder's rule
-- and wakes the agent only when its output changes.
ALTER TABLE reminders ADD COLUMN check_command TEXT;
ALTER TABLE reminders ADD COLUMN check_once INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reminders ADD COLUMN check_hash TEXT;
ALTER TABLE reminders ADD COLUMN check_output TEXT;
ALTER TABLE reminders ADD COLUMN check_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reminders ADD COLUMN check_error TEXT;
ALTER TABLE reminders ADD COLUMN last_checked_at INTEGER;
ALTER TABLE reminders ADD COLUMN check_until INTEGER;           -- the check stops then, and the agent hears so once
