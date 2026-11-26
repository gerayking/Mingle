import { afterEach, describe, expect, it } from "vitest";
import { type Rig, rig, runCli, until } from "./helpers.ts";

/** Knowing who is who: group members in the address book, finding them by name, notes coming back (docs/spec.md 4.2). */
describe("getting to know people", { timeout: 60_000 }, () => {
  let current: Rig | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  const MEMBERS = [
    { id: "u1", name: "Zhang San", isBot: false },
    { id: "u2", name: "Ying Shanshan", isBot: false },
    { id: "b9", name: "Other bot", isBot: true },
  ];
  const names = (r: Rig) =>
    r.mingle.store
      .agentContacts(r.agentId)
      .map((k) => k.name)
      .sort();

  it("puts a group's members in the address book when the bot joins, and again once the list is stale", async () => {
    current = await rig(async () => {});
    current.channel.members = MEMBERS;
    current.channel.joined({ platformId: "-200", kind: "group", name: "KBE" });
    await until(() => names(current as Rig).includes("Ying Shanshan"));
    await until(() => names(current as Rig).includes("Other bot") || undefined);
    // Other bots too, marked as bots: agents talk to each other.
    expect(names(current)).toEqual(["Other bot", "Ying Shanshan", "Zhang San"]);
    expect(current.mingle.store.agentContacts(current.agentId).find((k) => k.name === "Other bot")?.isBot).toBe(true);
    expect(current.channel.memberReads).toBe(1);

    // Active in the same group within a few hours: not read again.
    current.channel.receive({
      chat: { platformId: "-200", kind: "group", name: "KBE" },
      text: "hi",
      addressedToBot: false,
    });
    current.channel.receive({
      chat: { platformId: "-200", kind: "group", name: "KBE" },
      text: "hi",
      addressedToBot: false,
    });
    await until(() => current?.mingle.store.agentChats(current.agentId)[0]?.lastAt || undefined);
    expect(current.channel.memberReads).toBe(1);
  });

  it("reads a group it first hears from, and finds people by name", async () => {
    const out: Record<string, string> = {};
    let ran = false;
    current = await rig(async (t) => {
      if (ran) return;
      ran = true;
      const env = t.options.env as Record<string, string>;
      await until(() => (current?.channel.memberReads ?? 0) > 0 || undefined);
      await until(() => names(current as Rig).includes("Ying Shanshan") || undefined);
      out.found = (await runCli(env, ["contact", "list", "shanshan"])).stdout;
      out.none = (await runCli(env, ["contact", "list", "nobody"])).stdout;
    });
    current.channel.members = MEMBERS;
    current.channel.receive({ text: "@alex_bot who is in here?" });
    await until(() => out.none !== undefined || undefined, 30_000);
    expect(out.found).toContain("Ying Shanshan");
    expect(out.found).not.toContain("Zhang San");
    expect(out.none).toMatch(/^no contact named like "nobody"/);
  });

  it("shows the agent its note on someone with their first message in a session, once", async () => {
    const inputs: string[] = [];
    current = await rig(async (t) => {
      inputs.push(t.input);
      if (inputs.length > 1) return;
      const env = t.options.env as Record<string, string>;
      const user = /user=(u\w+)/.exec(t.input)?.[1] as string;
      await runCli(env, ["contact", "note", user], "Runs the hiking club. Prefers short messages.");
      await runCli(env, ["message", "send", "--to", /chat=(c\w+)/.exec(t.input)?.[1] as string], "noted");
    });
    const { channel } = current;
    channel.receive({ text: "@alex_bot I run the hiking club" });
    await until(() => channel.sent.length === 1);
    // Before the note existed: nothing to show.
    expect(inputs[0]).not.toContain("[mingle] About");

    const idle = () => until(() => !current?.mingle.runtime(current.agentId)?.busy || undefined);
    await idle();
    channel.receive({ text: "@alex_bot what's on Saturday?" });
    await until(() => inputs.find((i) => i.includes("what's on Saturday")));
    const second = inputs.find((i) => i.includes("what's on Saturday")) as string;
    expect(second).toMatch(
      /\[mingle\] About Zhang San \(u\w+\)\nYour note: Runs the hiking club\. Prefers short messages\.\n\[msg=/,
    );

    await idle();
    channel.receive({ text: "@alex_bot and Sunday?" });
    const third = await until(() => inputs.find((i) => i.includes("and Sunday?")));
    expect(third).not.toContain("[mingle] About");
  });

  it("learns where people sit and shows it with their first message", async () => {
    const inputs: string[] = [];
    current = await rig(async (t) => {
      inputs.push(t.input);
    });
    current.channel.members = MEMBERS;
    current.channel.profiles.set("u2", "Product · Product manager");
    current.channel.joined({ platformId: "-200", kind: "group", name: "KBE" });
    const store = current.mingle.store;
    const shanshan = await until(() =>
      store.agentContacts(current?.agentId as string).find((k) => k.profile === "Product · Product manager"),
    );
    // Bots have no profile to read.
    expect(store.agentContacts(current.agentId).find((k) => k.name === "Other bot")?.profile).toBeNull();

    current.channel.receive({
      chat: { platformId: "-200", kind: "group", name: "KBE" },
      sender: { id: "u2", name: "Ying Shanshan", isBot: false },
      text: "@alex_bot the operators live in kb-operators",
    });
    const first = await until(() => inputs.find((i) => i.includes("kb-operators")));
    expect(first).toContain(`[mingle] About Ying Shanshan (${shanshan.id}): Product · Product manager\n[msg=`);
  });
});
