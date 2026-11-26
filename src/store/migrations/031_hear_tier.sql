-- How fast a group that hears everything keeps up with a conversation, as the owner chose
-- (docs/spec.md 4.2): 'save', 'balanced' or 'fast'. NULL follows the group's size.
ALTER TABLE chats ADD COLUMN hear_tier TEXT;
