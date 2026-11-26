import type { ScriptedTurn } from "@botiverse/oar/testing";
import { afterEach, describe, expect, it } from "vitest";
import { TIDY_EVERY_MS, TIDY_IDLE_MS, tidyDue, tidyText } from "../src/core/home.ts";
import { messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

/** The daily memory tidy-up (docs/spec.md 4.5). */

let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

const HOUR = 3_600_000;

describe("tidyDue", () => {
  const base = { on: true, now: 100 * HOUR, idleSince: 90 * HOUR, tidyAt: 70 * HOUR, lastInAt: 80 * HOUR };

  it("is due when idle long enough, most of a day after the last one, with messages since", () => {
    expect(tidyDue(base)).toBe(true);
  });

  it("needs the switch on", () => {
    expect(tidyDue({ ...base, on: false })).toBe(false);
  });

  it("waits for the agent to have been idle for a while", () => {
    expect(tidyDue({ ...base, idleSince: base.now - TIDY_IDLE_MS + 1 })).toBe(false);
    expect(tidyDue({ ...base, idleSince: base.now - TIDY_IDLE_MS })).toBe(true);
  });

  it("comes at most once in a day", () => {
    expect(tidyDue({ ...base, tidyAt: base.now - TIDY_EVERY_MS + 1, lastInAt: base.now - HOUR * 3 })).toBe(false);
  });

  it("never wakes an agent nobody talked to", () => {
    expect(tidyDue({ ...base, lastInAt: null, tidyAt: null })).toBe(false);
    expect(tidyDue({ ...base, lastInAt: base.tidyAt - 1 })).toBe(false);
    expect(tidyDue({ ...base, lastInAt: base.tidyAt })).toBe(false);
  });

  it("gives the first one as soon as anyone has talked to it", () => {
    expect(tidyDue({ ...base, tidyAt: null })).toBe(true);
  });

  it("tells the agent to stay out of the chats", () => {
    expect(tidyText(null)).toContain("Do not send any message");
    expect(tidyText(0)).toContain("since 1970-01-01T00:00:00.000Z");
  });
});

/** A turn that answers every chat message in its input, and records everything it was given. */
function answering(inputs: string[]) {
  return async (t: ScriptedTurn) => {
    inputs.push(t.input);
    for (const id of messageIds(t.input)) {
      await runCli(t.options.env as Record<string, string>, ["message", "reply", id], "ok");
    }
  };
}

const tidies = (inputs: readonly string[]) => inputs.filter((i) => i.includes("[mingle] Daily memory tidy-up"));

describe("memory tidy-up", () => {
  it("gives an idle agent one turn of its own, at most once a day", async () => {
    const inputs: string[] = [];
    current = await rig(answering(inputs));
    const { mingle, channel, agentId } = current;
    expect(mingle.agent(agentId).tidy).toBe(true);

    // Nobody has talked to it yet: nothing to tidy.
    mingle.tidyMemories(Date.now() + 3 * HOUR);
    await new Promise((r) => setTimeout(r, 200));
    expect(tidies(inputs)).toHaveLength(0);

    channel.receive({ text: "remember that I like window seats" });
    await until(() => inputs.length === 1 && !mingle.runtime(agentId)?.busy);

    // Not idle long enough yet.
    mingle.tidyMemories(Date.now() + HOUR);
    await new Promise((r) => setTimeout(r, 200));
    expect(tidies(inputs)).toHaveLength(0);

    const at = Date.now() + 3 * HOUR;
    mingle.tidyMemories(at);
    await until(() => tidies(inputs).length === 1 && !mingle.runtime(agentId)?.busy);
    // An input of its own, not joined to a chat message; nothing was sent to the chat for it.
    expect(tidies(inputs)[0]?.startsWith("[mingle] Daily memory tidy-up")).toBe(true);
    expect(channel.sent).toHaveLength(1);
    expect(mingle.store.tidyAt(agentId)).toBe(at);

    // Once is enough until a new day brings new messages.
    mingle.tidyMemories(at + 2 * HOUR);
    mingle.tidyMemories(at + 30 * HOUR);
    await new Promise((r) => setTimeout(r, 200));
    expect(tidies(inputs)).toHaveLength(1);
  });

  it("is switched off from the console and never runs for a paused agent", async () => {
    const inputs: string[] = [];
    current = await rig(answering(inputs));
    const { mingle, channel, agentId, admin } = current;
    channel.receive({ text: "hello" });
    await until(() => inputs.length === 1 && !mingle.runtime(agentId)?.busy);

    const off = await admin("PUT", `/v1/admin/agents/${agentId}/tidy`, { on: false });
    expect(off.status).toBe(200);
    expect((off.json as { tidy: boolean }).tidy).toBe(false);
    mingle.tidyMemories(Date.now() + 3 * HOUR);
    await new Promise((r) => setTimeout(r, 200));
    expect(tidies(inputs)).toHaveLength(0);
    expect(mingle.store.tidyAt(agentId)).toBeNull();

    await admin("PUT", `/v1/admin/agents/${agentId}/tidy`, { on: true });
    await mingle.pauseAgent(agentId);
    mingle.tidyMemories(Date.now() + 3 * HOUR);
    await new Promise((r) => setTimeout(r, 200));
    expect(tidies(inputs)).toHaveLength(0);
    expect(mingle.store.tidyAt(agentId)).toBeNull();
  });
});
