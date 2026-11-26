-- Where a line's work happens (docs/spec.md 4.13): the thread it talks in, opened under the message it
-- works for, or the thread that message was already in. NULL where the chat app has no threads.
ALTER TABLE tasks ADD COLUMN thread_chat TEXT;
-- The latest word on how far the line is, one line: the first line of what it last said in its
-- thread, or what it reported with `task status`. Shown in the console.
ALTER TABLE tasks ADD COLUMN progress TEXT;
