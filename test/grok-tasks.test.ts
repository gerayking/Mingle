import { describe, expect, it } from "vitest";

// Pins Mingle's patch to OAR (patches/@botiverse__oar@*.patch): Grok reports background shells and
// monitors on `_x.ai/session/update`, which OAR 0.120.0 drops. Without them a line's session counts
// no background work, rests after its turn, and closing it kills the monitor (earayu/Mingle#196).
// The frames are Grok 1.0.92's, from real sessions, with paths and commands shortened.
type View = { kind: string; taskId?: string; taskType?: string; nativeType?: string; status?: string };
const { grokTaskViews } = (await import(
  new URL("./runtimes/grok/tasks.js", import.meta.resolve("@botiverse/oar")).href
)) as {
  grokTaskViews(method: string, params: unknown): View[];
};

const update = (body: Record<string, unknown>) => ({ sessionId: "s1", update: body, _meta: { eventId: "s1-1" } });

describe("Grok background tasks", () => {
  it("counts a monitor from the moment it leaves the turn until it ends", () => {
    expect(
      grokTaskViews(
        "_x.ai/session/update",
        update({
          sessionUpdate: "task_backgrounded",
          tool_call_id: "call-1",
          task_id: "01a0134f",
          command: "bash watch.sh",
          cwd: "/agents/a",
          output_file: "/sessions/s1/terminal/monitor.log",
          monitor_description: "Watch the run until it finishes",
          description: "Watch the run until it finishes",
        }),
      ),
    ).toEqual([
      {
        kind: "task_started",
        taskId: "01a0134f",
        taskType: "shell",
        nativeType: "monitor",
        background: true,
        description: "Watch the run until it finishes",
        toolCallId: "call-1",
      },
    ]);
    expect(
      grokTaskViews(
        "_x.ai/session/update",
        update({
          sessionUpdate: "task_completed",
          task_snapshot: {
            task_id: "01a0134f",
            kind: "monitor",
            exit_code: 0,
            signal: null,
            completed: true,
            explicitly_killed: false,
            output_file: "/sessions/s1/terminal/monitor.log",
            is_backgrounded: true,
          },
          will_wake: true,
        }),
      ),
    ).toEqual([
      { kind: "task_ended", taskId: "01a0134f", status: "completed", outputFile: "/sessions/s1/terminal/monitor.log" },
    ]);
  });

  it("counts a command moved to the background, and reads how it ended", () => {
    const [started] = grokTaskViews(
      "_x.ai/session/update",
      update({
        sessionUpdate: "task_backgrounded",
        task_id: "call-9",
        tool_call_id: "call-9",
        command: "make",
        background_reason: "timeout",
      }),
    );
    expect(started).toMatchObject({ kind: "task_started", taskId: "call-9", taskType: "shell", nativeType: "bash" });
    const ended = (snapshot: Record<string, unknown>) =>
      grokTaskViews(
        "_x.ai/session/update",
        update({ sessionUpdate: "task_completed", task_snapshot: { task_id: "call-9", ...snapshot } }),
      )[0]?.status;
    expect(ended({ exit_code: 1, explicitly_killed: false })).toBe("failed");
    expect(ended({ exit_code: null, signal: "killed", explicitly_killed: true })).toBe("stopped");
  });

  it("still reads sub-agents, and ignores the task list snapshot", () => {
    expect(
      grokTaskViews("_x.ai/session_notification", update({ sessionUpdate: "subagent_spawned", subagent_id: "sa1" })),
    ).toMatchObject([{ kind: "task_started", taskId: "sa1", taskType: "agent" }]);
    expect(
      grokTaskViews(
        "_x.ai/session/update",
        update({ sessionUpdate: "background_tasks", tasks: [{ task_id: "x", status: "running" }] }),
      ),
    ).toEqual([]);
  });
});
