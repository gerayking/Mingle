-- Teams are gone (docs/spec.md 4.13): every agent can do several things at once instead. Members go
-- back to being agents of their own; what was given to them returns to whoever gave it, and their
-- private team chats go with the team. The columns of 025 stay, unused: a referenced column cannot
-- be dropped, and old migrations are not edited.
INSERT INTO owner_notes (agent_id, body, created_at)
  SELECT agent_id,
         '[mingle] Teams were removed from Mingle. Task ' || id || ' ("' || replace(title, '"', '''') || '") is yours again; run it yourself, or start it with "$MINGLE_CLI" task run.',
         CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM tasks WHERE assignee_id IS NOT NULL AND status IN ('todo', 'in_progress');
UPDATE tasks SET assignee_id = NULL;
UPDATE agents SET lead_id = NULL;
DELETE FROM connections WHERE platform = 'team';

-- A line: a task the agent works on in a session of its own, beside its main one.
-- line_state: queued (waiting for a free line) | running (a turn is under way or due) | idle (the
-- session waits for a follow-up) | ended (stopped) | error. NULL for a task that is only a note.
ALTER TABLE tasks ADD COLUMN line_state TEXT;
ALTER TABLE tasks ADD COLUMN session_id TEXT;
ALTER TABLE tasks ADD COLUMN brief TEXT;
ALTER TABLE tasks ADD COLUMN summary TEXT;
ALTER TABLE tasks ADD COLUMN line_error TEXT;
-- Which line a message belongs to: one the line sent, or a follow-up Mingle handed to it.
ALTER TABLE messages ADD COLUMN line_task_id TEXT;
CREATE INDEX messages_line ON messages(line_task_id) WHERE line_task_id IS NOT NULL;
