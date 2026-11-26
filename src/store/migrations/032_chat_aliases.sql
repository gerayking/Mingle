-- What else people in a group call the agent there (docs/spec.md 4.2): a JSON array of names that
-- count as calling it, like its own name. NULL: none. Kept when hearing everything is turned off.
ALTER TABLE chats ADD COLUMN aliases TEXT;
