-- The other person in a direct chat, by their ID on the platform: how the agent finds the chat
-- again when it messages them by contact, and how a chat it opened itself is found (docs/spec.md 5.3).
ALTER TABLE chats ADD COLUMN peer_id TEXT;
UPDATE chats SET peer_id = (
  SELECT m.sender_id FROM messages m
  WHERE m.chat_id = chats.id AND m.direction = 'in' AND m.sender_id IS NOT NULL
  ORDER BY m.created_at LIMIT 1
) WHERE kind = 'dm';
CREATE INDEX chats_peer ON chats(connection_id, peer_id) WHERE peer_id IS NOT NULL;
