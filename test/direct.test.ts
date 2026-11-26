import { afterEach, describe, expect, it } from "vitest";
import { type Rig, rig, runCli, until } from "./helpers.ts";

/** `message send --to <contact>`: a direct chat with someone who has not written to the bot (docs/spec.md 5.3). */
// Each case runs the real CLI a few times; give it room on a busy machine.
describe("messaging a person directly", { timeout: 60_000 }, () => {
  let current: Rig | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  const MEMBERS = [
    { id: "u1", name: "Zhang San", isBot: false },
    { id: "u2", name: "Ying Shanshan", isBot: false },
  ];

  /** A rig whose agent, on the first group message, looks up the group and runs `steps`. */
  async function scene(
    mode: "none" | "chat" | "user",
    steps: (cli: (args: string[], stdin?: string) => ReturnType<typeof runCli>, group: string) => Promise<void>,
  ) {
    const inputs: string[] = [];
    let started = false;
    let done = false;
    current = await rig(async (t) => {
      inputs.push(t.input);
      if (started) return;
      started = true;
      const env = t.options.env as Record<string, string>;
      const group = /chat=(c\w+)/.exec(t.input)?.[1] as string;
      await steps((args, stdin = "") => runCli(env, args, stdin), group);
      done = true;
    });
    current.channel.members = MEMBERS;
    current.channel.opensDirect = mode;
    current.channel.receive({ text: "@alex_bot ask Shanshan about the repo" });
    return { rig: current, inputs, finished: () => done };
  }

  it("lists group members with contact IDs and opens a direct chat on the first send", async () => {
    const out: Record<string, string> = {};
    const { rig: r, finished } = await scene("chat", async (cli, group) => {
      out.info = (await cli(["chat", "info", group])).stdout;
      const id = /(u\w+)\s+"Ying Shanshan"/.exec(out.info)?.[1] as string;
      out.first = (await cli(["message", "send", "--to", id], "Hi Shanshan, which repo holds the operators?")).stdout;
      out.second = (await cli(["message", "send", "--to", id], "No rush.")).stderr;
      out.id = id;
    });
    await until(() => finished(), 30_000);
    expect(r.channel.sent).toHaveLength(2);
    expect(out.info).toMatch(/^members:$/m);
    expect(out.info).toMatch(/u\w+\s+"Zhang San"/);
    expect(out.id).toMatch(/^u\w+$/);
    // Both sends go to one direct chat, opened once.
    expect(r.channel.sent.map((m) => m.chat)).toEqual([
      { platformId: "dm-u2", kind: "dm", name: "Ying Shanshan" },
      { platformId: "dm-u2", kind: "dm", name: "Ying Shanshan" },
    ]);
    expect(out.second).toBe("");

    // Her answer lands in that chat — as a new turn, or steered into the one still finishing.
    r.channel.receive({ chat: { platformId: "dm-u2", kind: "dm" }, sender: MEMBERS[1] as never, text: "kb-operators" });
    const answer = await until(() =>
      r.turns.flatMap((t) => [t.input, ...t.steered]).find((i) => i.includes("kb-operators")),
    );
    const chats = r.mingle.store.agentChats(r.agentId).filter((c) => c.kind === "dm");
    expect(chats).toHaveLength(1);
    expect(answer).toContain(`chat=${chats[0]?.id}`);
  });

  it("learns the chat's own ID from the first send where the chat is named only then", async () => {
    const out: Record<string, string> = {};
    const { rig: r, finished } = await scene("user", async (cli, group) => {
      const info = (await cli(["chat", "info", group])).stdout;
      const id = /(u\w+)\s+"Ying Shanshan"/.exec(info)?.[1] as string;
      await cli(["message", "send", "--to", id], "Hi Shanshan.");
      out.second = (await cli(["message", "send", "--to", id], "Which repo?")).stderr;
    });
    await until(() => finished(), 30_000);
    // Addressed by her ID first, then by the chat Feishu reported back.
    expect(r.channel.sent.map((m) => m.chat.platformId)).toEqual(["user:u2", "dm-u2"]);
    expect(out.second).toBe("");
    r.channel.receive({ chat: { platformId: "dm-u2", kind: "dm" }, sender: MEMBERS[1] as never, text: "kb-operators" });
    await until(() => r.turns.flatMap((t) => [t.input, ...t.steered]).find((i) => i.includes("kb-operators")));
    expect(r.mingle.store.agentChats(r.agentId).filter((c) => c.kind === "dm")).toHaveLength(1);
  });

  it("uses the direct chat someone already has with the bot", async () => {
    const out: Record<string, string> = {};
    current = await rig(async (t) => {
      if (out.sent !== undefined) return;
      // The group message may come as its own turn or into the one the direct message opened.
      const seen = () => [t.input, ...t.steered].find((i) => i.includes("reply to me in private"));
      const ask = await until(() => seen(), 20_000).catch(() => undefined);
      if (!ask || out.sent !== undefined) return;
      const env = t.options.env as Record<string, string>;
      const user = /user=(u\w+)/.exec(ask)?.[1] as string;
      out.sent = (await runCli(env, ["message", "send", "--to", user], "Saw your note.")).stderr;
    });
    current.channel.opensDirect = "none";
    current.channel.receive({ chat: { platformId: "77", kind: "dm" }, text: "hello" });
    current.channel.receive({ text: "@alex_bot reply to me in private" });
    await until(() => out.sent !== undefined || undefined, 30_000);
    expect(out.sent).toBe("");
    expect(current.channel.sent.at(-1)?.chat.platformId).toBe("77");
  });

  it("says when the chat app lets a bot write only to people who wrote first", async () => {
    const out: Record<string, string> = {};
    const { finished } = await scene("none", async (cli, group) => {
      const info = (await cli(["chat", "info", group])).stdout;
      const id = /(u\w+)\s+"Ying Shanshan"/.exec(info)?.[1] as string;
      out.err = (await cli(["message", "send", "--to", id], "Hi")).stderr;
    });
    await until(() => finished(), 30_000);
    expect(out.err).toMatch(/^error: direct_unavailable\nnext: telegram lets a bot message only people/);
    expect(out.err).toContain("Do not write to them through another account on this computer");
  });

  it("says when the chat app refuses the person", async () => {
    const out: Record<string, string> = {};
    const { finished } = await scene("chat", async (cli, group) => {
      current?.channel.unreachable.add("u2");
      const info = (await cli(["chat", "info", group])).stdout;
      const id = /(u\w+)\s+"Ying Shanshan"/.exec(info)?.[1] as string;
      out.err = (await cli(["message", "send", "--to", id], "Hi")).stderr;
    });
    await until(() => finished(), 30_000);
    expect(out.err).toMatch(/^error: direct_refused\n/);
    expect(current?.mingle.store.agentChats(current.agentId).filter((c) => c.kind === "dm")).toHaveLength(0);
  });
});
