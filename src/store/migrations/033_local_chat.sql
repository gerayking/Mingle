-- The owner's private chat in the console (docs/spec.md 6.9). When the owner last saw it, so the
-- console and the desktop app can tell what the agent said there since.
ALTER TABLE agents ADD COLUMN chat_seen_at INTEGER NOT NULL DEFAULT 0;

-- Getting started is about reaching the agent in a chat app: an answer in the private chat does
-- not complete it.
DROP TRIGGER messages_onboarding_insert;
DROP TRIGGER messages_onboarding_update;

CREATE TRIGGER messages_onboarding_insert AFTER INSERT ON messages
WHEN new.direction = 'out' AND new.state = 'sent' AND new.notice = 0
BEGIN
  UPDATE agents SET has_replied = 1
  WHERE has_replied = 0 AND id = (
    SELECT n.agent_id FROM chats c JOIN connections n ON n.id = c.connection_id
    WHERE c.id = new.chat_id AND n.platform <> 'local'
  );
END;

CREATE TRIGGER messages_onboarding_update AFTER UPDATE OF state ON messages
WHEN new.direction = 'out' AND new.state = 'sent' AND new.notice = 0
BEGIN
  UPDATE agents SET has_replied = 1
  WHERE has_replied = 0 AND id = (
    SELECT n.agent_id FROM chats c JOIN connections n ON n.id = c.connection_id
    WHERE c.id = new.chat_id AND n.platform <> 'local'
  );
END;
