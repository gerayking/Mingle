import { afterEach, describe, expect, it } from "vitest";
import { Mingle } from "../src/core/mingle.ts";
import { type Rig, rig, until } from "./helpers.ts";

/** Mingle stopping in the middle of a turn (a restart, an update): the work is picked up again (docs/spec.md 7.1). */

let current: Rig | undefined;
let again: Mingle | undefined;
const gates: (() => void)[] = [];
afterEach(async () => {
  for (const release of gates.splice(0)) release();
  await again?.stop();
  again = undefined;
  await current?.close();
  current = undefined;
});

/** A turn that hangs until the test ends, recording what it was given: the work in hand when Mingle stops. */
function hanging(inputs: string[]) {
  return async (t: { input: string }) => {
    inputs.push(t.input);
    if (inputs.length === 1) await new Promise<void>((r) => gates.push(r));
  };
}

/** What happens when Mingle goes away now: its runtimes close as on quit, without ending the turn first. */
async function restart(rig: Rig): Promise<Mingle> {
  for (const agent of rig.mingle.store.agents()) await rig.mingle.runtime(agent.id)?.dispose();
  const next = new Mingle(rig.mingle.options);
  await next.start("http://127.0.0.1:1");
  return next;
}

describe("work interrupted by a restart", () => {
  it("tells the agent to carry on and hands it the messages that turn had not answered", async () => {
    const inputs: string[] = [];
    current = await rig(hanging(inputs));
    const { mingle, channel, agentId } = current;
    const incoming = channel.receive({ text: "build me the report" });
    await until(() => mingle.runtime(agentId)?.busy);
    expect(mingle.store.turnAt(agentId)).not.toBeNull();

    again = await restart(current);
    await until(() => inputs.length >= 2);
    expect(inputs[1]).toMatch(/^\[mingle\] Mingle restarted while you were working/);
    // Handed over again once, after the note.
    expect(inputs[1]?.split("build me the report")).toHaveLength(2);
    // Not answered in that turn: reminded once, then given up, as after any turn.
    const chat = again.store.agentChats(agentId)[0] as { id: string };
    await until(() => again?.store.messageByPlatformId(chat.id, incoming.platformId)?.state === "unanswered");
    expect(inputs[2]).toMatch(/^\[mingle\] Not answered yet/);
    // The new turn ended: nothing is marked as running any more.
    await until(() => !again?.runtime(agentId)?.busy && again?.store.turnAt(agentId) === null);
  });

  it("picks up a turn no chat message started, such as a reminder", async () => {
    const inputs: string[] = [];
    current = await rig(hanging(inputs));
    const { mingle, agentId } = current;
    await until(() => mingle.store.agent(agentId)?.status === "idle");
    mingle.runtime(agentId)?.enqueueText("[mingle] Reminder r1: send the weekly summary");
    await until(() => mingle.runtime(agentId)?.busy);

    again = await restart(current);
    await until(() => inputs.length === 2);
    expect(inputs[1]).toMatch(/^\[mingle\] Mingle restarted while you were working/);
    expect(inputs[1]).not.toContain("follow again");
  });

  it("starts quietly when no turn was running", async () => {
    const inputs: string[] = [];
    current = await rig(async (t) => {
      inputs.push(t.input);
    });
    await until(() => current?.mingle.store.agent(current.agentId)?.status === "idle");
    again = await restart(current);
    await until(() => again?.store.agent(current?.agentId ?? "")?.status === "idle");
    await new Promise((r) => setTimeout(r, 400));
    expect(inputs).toHaveLength(0);
  });

  it("does not pick up work the owner paused", async () => {
    const inputs: string[] = [];
    current = await rig(hanging(inputs));
    const { mingle, channel, agentId, admin } = current;
    channel.receive({ text: "long job" });
    await until(() => mingle.runtime(agentId)?.busy);
    await admin("POST", `/v1/admin/agents/${agentId}/pause`);
    await until(() => mingle.store.turnAt(agentId) === null);
    await admin("POST", `/v1/admin/agents/${agentId}/resume`);
    await until(() => mingle.store.agent(agentId)?.status === "idle");
    await new Promise((r) => setTimeout(r, 400));
    expect(inputs).toHaveLength(1);
  });
});
