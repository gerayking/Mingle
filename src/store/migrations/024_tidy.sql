-- The daily memory tidy-up (docs/spec.md 4.5): whether the agent gets it, on by default, and when
-- it was last given, so it comes at most once a day and only after people talked to the agent.
ALTER TABLE agents ADD COLUMN tidy INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN tidy_at INTEGER;
