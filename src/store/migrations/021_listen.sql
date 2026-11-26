-- A group set to hear everything (docs/spec.md 4.2): messages there that do not @ the agent still
-- reach it, a stretch at a time, and it decides whether to speak. Off by default.
ALTER TABLE chats ADD COLUMN listen INTEGER NOT NULL DEFAULT 0;
