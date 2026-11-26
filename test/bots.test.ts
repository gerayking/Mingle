import { afterEach, describe, expect, it } from "vitest";
import { botBrakeNote } from "../src/core/live.ts";
import { BotHops, MAX_BOT_HOPS, trigger } from "../src/core/trigger.ts";
import { messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

/** Other bots in the agent's chats, and the brake on bots waking each other (docs/spec.md 4.2). */
describe("trigger rules", () => {
  const person = { dm: false, bot: false, mentioned: false, addressed: false, hops: 0 };
  const bot = { ...person, bot: true };

  it("wakes the agent for people as before", () => {
    expect(trigger({ ...person, dm: true })).toBe("wake");
    expect(trigger({ ...person, addressed: true })).toBe("wake");
    expect(trigger(person)).toBe("background");
    // People are never braked, however long bots have been at it.
    expect(trigger({ ...person, addressed: true, hops: 99 })).toBe("wake");
  });

  it("lets a bot wake it only with a mention in the text", () => {
    expect(trigger(bot)).toBe("background");
    // A reply to the agent, or a direct message, is not a handoff.
    expect(trigger({ ...bot, addressed: true })).toBe("background");
    expect(trigger({ ...bot, dm: true })).toBe("background");
    // Writing its name in a direct message is not a handoff either, on any platform.
    expect(trigger({ ...bot, dm: true, mentioned: true })).toBe("background");
    expect(trigger({ ...bot, addressed: true, mentioned: true })).toBe("wake");
    expect(trigger({ ...bot, mentioned: true, hops: MAX_BOT_HOPS - 1 })).toBe("wake");
    expect(trigger({ ...bot, mentioned: true, hops: MAX_BOT_HOPS })).toBe("brake");
  });

  it("counts bot turns per chat until a person speaks, and says so once", () => {
    const hops = new BotHops();
    for (let i = 0; i < MAX_BOT_HOPS; i++) hops.woke("c1");
    hops.woke("c2");
    expect(hops.hops("c1")).toBe(MAX_BOT_HOPS);
    expect(hops.hops("c2")).toBe(1);
    expect(hops.braked("c1")).toBe(true);
    expect(hops.braked("c1")).toBe(false);
    hops.person("c1");
    expect(hops.hops("c1")).toBe(0);
    for (let i = 0; i < MAX_BOT_HOPS; i++) hops.woke("c1");
    expect(hops.braked("c1")).toBe(true);
  });

  it("names the other bot without mentioning it", () => {
    expect(botBrakeNote("telegram", "@bob_bot")).toBe(
      `bob_bot and I have gone back and forth ${MAX_BOT_HOPS} times, so I'm stopping here. @ me if you want me to go on.`,
    );
    expect(botBrakeNote("feishu", "")).toContain("我和 另一个机器人 已经来回");
  });
});

describe("bots in a chat", () => {
  let current: Rig | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  const bob = { id: "b9", name: "Bob", isBot: true };

  /** The session's environment, as the last turn had it: lets a test run the CLI as the agent. */
  let env: Record<string, string> = {};

  async function setup() {
    current = await rig(async (t) => {
      env = t.options.env as Record<string, string>;
      for (const id of messageIds(t.input)) await runCli(env, ["message", "reply", id], "ok");
    });
    return current;
  }

  it("keeps what other bots say as background, and marks them in the header", async () => {
    const { mingle, channel, agentId, turns } = await setup();
    // Not mentioned, and a reply to the agent: kept, not delivered.
    channel.receive({ text: "deploy failed: exit 1", sender: bob, addressedToBot: false });
    channel.receive({ text: "thanks!", sender: bob, addressedToBot: true, mentioned: false });
    const chat = mingle.store.agentChats(agentId)[0] as { id: string };
    await until(() => mingle.store.chatMessages(chat.id, 10).length === 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(turns).toHaveLength(0);
    expect(mingle.store.chatMessages(chat.id, 10).every((m) => m.state === "ignored")).toBe(true);

    // A person asks about it; the agent sees the bot marked when it reads the chat.
    channel.receive({ text: "@alex what did the deploy bot say?" });
    await until(() => turns.length === 1);
    const read = await runCli(env, ["message", "read", chat.id]);
    expect(read.stdout).toMatch(/from="Bob" user=u\w+ bot time=.+\ndeploy failed: exit 1/);
    const contacts = await runCli(env, ["contact", "list"]);
    expect(contacts.stdout).toMatch(/"Bob"\s+bot/);
  });

  it("keeps a group's earlier messages as background, even the ones that @ it", async () => {
    const { mingle, channel, agentId, turns } = await setup();
    channel.receive({ text: "@alex where on Saturday?", earlier: true, sentAt: Date.now() - 60_000 });
    channel.receive({
      text: "deploy failed",
      sender: bob,
      mentioned: true,
      earlier: true,
      sentAt: Date.now() - 30_000,
    });
    const chat = mingle.store.agentChats(agentId)[0] as { id: string };
    await until(() => mingle.store.chatMessages(chat.id, 10).length === 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(turns).toHaveLength(0);
    expect(mingle.store.chatMessages(chat.id, 10).every((m) => m.state === "ignored")).toBe(true);
    // Read when someone asks now: the past is there, counted as unseen.
    channel.receive({ text: "@alex so, where?" });
    await until(() => turns.length === 1);
    const read = await runCli(env, ["message", "read", chat.id]);
    expect(read.stdout).toContain("where on Saturday?");
  });

  it("stops bots waking it after five turns in a row, until a person speaks", async () => {
    const { mingle, channel, agentId, turns } = await setup();
    const ask = (text: string) => channel.receive({ text, sender: bob, mentioned: true });
    for (let i = 1; i <= 5; i++) {
      ask(`@alex round ${i}`);
      await until(() => turns.length === i);
    }
    const before = channel.sent.length;
    ask("@alex round 6");
    ask("@alex round 7");
    // Said once, not quoting the bot, and the bot's messages are kept without waking the agent.
    await until(() => channel.sent.some((m) => m.text.includes("back and forth")));
    await new Promise((r) => setTimeout(r, 300));
    const notes = channel.sent.slice(before).filter((m) => m.text.includes("back and forth"));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain("Bob and I");
    expect(notes[0]?.replyTo).toBeUndefined();
    expect(turns).toHaveLength(5);
    const chat = mingle.store.agentChats(agentId)[0] as { id: string };
    const stopped = mingle.store.chatMessages(chat.id, 50).filter((m) => m.body.startsWith("@alex round 6"));
    expect(stopped[0]?.state).toBe("ignored");

    // A person speaking, even without addressing the agent, gives bots their turns back.
    channel.receive({ text: "carry on, you two", addressedToBot: false });
    ask("@alex round 8");
    await until(() => turns.length === 6);
  });

  it("learns whom a message mentions, so the agent can mention them back (MING-107)", async () => {
    const { mingle, channel, agentId, turns } = await setup();
    channel.receive({
      text: "@alex @Bryce小跟班 你们聊几句",
      mentions: [{ id: "ou_bryce", name: "Bryce小跟班", isBot: true }],
    });
    await until(() => turns.length === 1);
    const connection = mingle.store.connections(agentId).filter((n) => n.platform !== "local")[0];
    expect(mingle.store.contactByPlatformId(connection?.id as string, "ou_bryce")).toMatchObject({
      name: "Bryce小跟班",
      isBot: true,
    });
  });

  it("recognizes this computer's agents, and never makes a bot the owner", async () => {
    const { mingle, channel, agentId, turns, admin } = await setup();
    // The bot this computer runs on the platform: the platform does not flag it, Mingle knows it.
    channel.receive({
      text: "hi",
      chat: { platformId: "bot1", kind: "dm" },
      sender: { id: "bot1", name: "Alex", isBot: false },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(turns).toHaveLength(0);
    const connection = mingle.store.connections(agentId).filter((n) => n.platform !== "local")[0];
    expect(connection?.ownerId).toBeNull();
    expect(mingle.store.contactByPlatformId(connection?.id as string, "bot1")?.isBot).toBe(true);

    // The owner claims the bot with its code (docs/spec.md 4.7), then marks an account the platform
    // does not flag; the owner cannot be marked.
    channel.receive({
      text: connection?.claimCode as string,
      chat: { platformId: "me", kind: "dm" },
      sender: { id: "me", name: "Me", isBot: false },
    });
    await until(() => mingle.store.connection(connection?.id as string)?.ownerId === "me");
    channel.receive({
      text: "hello",
      chat: { platformId: "me", kind: "dm" },
      sender: { id: "me", name: "Me", isBot: false },
    });
    await until(() => turns.length === 1);
    channel.receive({ text: "@alex ping", sender: { id: "u5", name: "Carol's agent", isBot: false } });
    await until(() => turns.length === 2);
    const carol = mingle.store.contactByPlatformId(connection?.id as string, "u5");
    const marked = await admin("PATCH", `/v1/admin/agents/${agentId}/contacts/${carol?.id}`, { bot: true });
    expect(marked.json).toEqual({ id: carol?.id, name: "Carol's agent", bot: true });
    channel.receive({
      text: "ping again",
      sender: { id: "u5", name: "Carol's agent", isBot: false },
      mentioned: false,
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(turns).toHaveLength(2);
    const me = mingle.store.contactByPlatformId(connection?.id as string, "me");
    expect((await admin("PATCH", `/v1/admin/agents/${agentId}/contacts/${me?.id}`, { bot: true })).status).toBe(409);
    expect((await admin("PATCH", `/v1/admin/agents/${agentId}/contacts/${carol?.id}`, { bot: "yes" })).status).toBe(
      400,
    );
  });
});
