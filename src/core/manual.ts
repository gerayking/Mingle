import { readFileSync } from "node:fs";

const TEMPLATE = new URL("../cli/manual.md", import.meta.url);

/**
 * On Windows a harness may run commands in PowerShell, where `"$MINGLE_CLI"` and heredocs
 * mean nothing. Only Windows agents read this.
 */
const POWERSHELL = `
## If your shell is PowerShell

The examples are bash. In PowerShell, run the CLI with \`& $env:MINGLE_CLI\` and pipe the body in as a here-string, after setting UTF-8 so non-English text survives:

\`\`\`powershell
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
@'
Saturday looks clear.
'@ | & $env:MINGLE_CLI message reply m8f2a
\`\`\`
`;

/**
 * The names of the variables the owner set for this agent. Never their values: the guide goes into
 * the transcript and to the model's provider.
 */
function envSection(names: readonly string[], platform: NodeJS.Platform): string {
  const read = platform === "win32" ? "`$env:NAME` in PowerShell, `$NAME` in bash" : "`$NAME`";
  return `
## Environment variables set for you

Your owner set these for you: ${names.map((n) => `\`${n}\``).join(", ")}. Read them in your shell as ${read}. They hold secrets such as webhook addresses and API keys: use them in commands, and do not write their values into messages, files or notes.
`;
}

/** The task a line works on (docs/spec.md 4.13): what its session is for. */
export interface LineGuide {
  readonly taskId: string;
  readonly title: string;
  /** The agent's home: read it, but its role, memory and notes are the main session's to write. */
  readonly home: string;
}

/** What sets a line's session apart from the agent's main one. */
function lineSection(line: LineGuide): string {
  return `
## This session: one task

This session of yours works on one task: ${line.taskId}, "${line.title}". Your main session talks with people and started this one; "Doing long work" above is about it, not you. You are still {{name}}: same name, same voice, same bot.

- Speak only about this task. Anything else is refused with \`line_out_of_scope\`.
- Your first input carries the brief, the message the work is for, what was said before it in that chat, and a \`[mingle]\` line saying where you talk while you work.
- Where the work has a thread (the chat app has threads): \`message send\` goes into it, and your first one opens it under the message. Speak there at these moments only: when you start, when you need to ask someone, when the direction changes. Not at every step: at most three messages before the result. Asking a particular person, @-mention them by name so they are notified. What people say in the thread reaches you, without an @.
- Where there is no thread: do not post progress. Say how far you are with \`"$MINGLE_CLI" task status "Found the cause; fixing it"\` (one line, shown to your owner), and \`message send\` only to ask the person something.
- When what is asked is unclear, ask before you start rather than after.
- Work in this directory. To change a git repository, use a worktree of your own (\`git worktree add\`), so other work on the same repository is not disturbed.
- Read \`${line.home}\` (\`MEMORY.md\`, \`notes/\`) for background, but do not change \`ROLE.md\`, \`MEMORY.md\` or \`notes/\`: they are your main session's.
- When done, \`message reply\` to the message the work is for, with the result: it goes to the chat itself, where everyone sees it, even when you worked in a thread. Mention the person who asked by name. Then finish with \`"$MINGLE_CLI" task done ${line.taskId}\`, a summary on standard input: what you did, where the result is, why, and what you learned that is worth remembering. Your main session reads it.
- People may follow up later; their messages wake this session again, and you carry on from here.
- When someone tells you to stop, say in one line how far you got, then \`"$MINGLE_CLI" task update ${line.taskId} --status closed\`. This session ends after that.
- You cannot start other lines.
`;
}

/** The operating guide appended to the harness's system prompt; `mingle manual` prints the same text. */
export function renderManual(
  name: string,
  role: string,
  platform: NodeJS.Platform = process.platform,
  envNames: readonly string[] = [],
  line?: LineGuide,
): string {
  let manual = readFileSync(TEMPLATE, "utf8")
    .replaceAll("{{name}}", name)
    .replace("{{role}}", role.trim() || "(Your owner has not written a role yet.)");
  if (line) manual = `${manual.trimEnd()}\n${lineSection(line).replaceAll("{{name}}", name)}`;
  if (envNames.length) manual = `${manual.trimEnd()}\n${envSection(envNames, platform)}`;
  return platform === "win32" ? `${manual.trimEnd()}\n${POWERSHELL}` : manual;
}
