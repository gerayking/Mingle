-- Teams (docs/spec.md 4.13): an agent may lead others. A member names its lead; one team per agent,
-- one level. Deleting the lead leaves its members on their own.
ALTER TABLE agents ADD COLUMN lead_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
-- A task the lead gave a member of its team: who is doing it.
ALTER TABLE tasks ADD COLUMN assignee_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
