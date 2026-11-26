-- Mingle's own words in a chat (a new bot's greeting, "I asked my owner", the owner's notice of
-- someone waiting): kept with the chat so the console shows them, but not the agent's messages
-- (docs/spec.md 4.7). They do not complete onboarding, end any message, or count as the agent speaking.
ALTER TABLE messages ADD COLUMN notice INTEGER NOT NULL DEFAULT 0 CHECK (notice IN (0, 1));

DROP TRIGGER messages_onboarding_insert;
DROP TRIGGER messages_onboarding_update;

CREATE TRIGGER messages_onboarding_insert AFTER INSERT ON messages
WHEN new.direction = 'out' AND new.state = 'sent' AND new.notice = 0
BEGIN
  UPDATE agents SET has_replied = 1
  WHERE has_replied = 0 AND id = (
    SELECT n.agent_id FROM chats c JOIN connections n ON n.id = c.connection_id
    WHERE c.id = new.chat_id
  );
END;

CREATE TRIGGER messages_onboarding_update AFTER UPDATE OF state ON messages
WHEN new.direction = 'out' AND new.state = 'sent' AND new.notice = 0
BEGIN
  UPDATE agents SET has_replied = 1
  WHERE has_replied = 0 AND id = (
    SELECT n.agent_id FROM chats c JOIN connections n ON n.id = c.connection_id
    WHERE c.id = new.chat_id
  );
END;
