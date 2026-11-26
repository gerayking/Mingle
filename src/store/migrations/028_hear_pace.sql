-- How often a group that hears everything reaches the agent, as the agent set it (docs/spec.md 4.2):
-- NULL is Mingle's own pace; 'every' at most once per `hear_every_ms`; 'muted' not at all until
-- someone addresses the agent there.
ALTER TABLE chats ADD COLUMN hear_pace TEXT;
ALTER TABLE chats ADD COLUMN hear_every_ms INTEGER;
