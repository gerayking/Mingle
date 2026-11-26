-- User-chosen sidebar order of agents (local and remote agent IDs).
-- Agents not listed keep their default order after the listed ones.
CREATE TABLE agent_order (
  agent_id TEXT PRIMARY KEY,
  position INTEGER NOT NULL
) STRICT;
