-- When the agent's current turn began, cleared when it ends (docs/spec.md 7.1). Still set when
-- Mingle starts means the last run stopped mid-turn: the agent is told to pick the work up again.
ALTER TABLE agents ADD COLUMN turn_at INTEGER;
