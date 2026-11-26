import { afterEach, describe, expect, it } from "vitest";
import type { ChannelConnection, OutboundMessage } from "../src/channels/channel.ts";
import { mentionSpots, renderMentions } from "../src/channels/mention.ts";
import { Outbox } from "../src/core/outbox.ts";
import { Store } from "../src/store/store.ts";

describe("mentionSpots", () => {
  const bob = { id: "U1", name: "Bob" };
  const bobSmith = { id: "U2", name: "Bob Smith" };
  const pm = { id: "ou_pm", name: "Mingle产品经理" };
  const names = (text: string, list = [bob, bobSmith, pm]) =>
    mentionSpots(text, list).map((s) => text.slice(s.start, s.end));

  it("finds names, the longest first, with any case", () => {
    expect(names("@Bob Smith and @bob, hi")).toEqual(["@Bob Smith", "@bob"]);
  });

  it("lets a CJK name run straight into the sentence, but not a Latin one into a longer word", () => {
    expect(names("@Mingle产品经理想听你一句")).toEqual(["@Mingle产品经理"]);
    expect(names("@Bobby hi")).toEqual([]);
    expect(names("@Bob你好")).toEqual(["@Bob"]);
  });

  it("leaves e-mail addresses and code alone", () => {
    expect(names("mail bob@Bob.com or `@Bob` or\n```\n@Bob\n```\n")).toEqual([]);
  });

  it("renders each spot and keeps the rest", () => {
    expect(renderMentions("hi @Bob!", [bob], (m) => `<@${m.id}>`)).toBe("hi <@U1>!");
    expect(renderMentions("hi @Bob!", undefined, () => "x")).toBe("hi @Bob!");
  });
});

describe("outbox mentions", () => {
  let store: Store;
  afterEach(() => store.close());

  const setup = (options: { mentions?: true; kind?: "group" | "dm" } = { mentions: true }) => {
    store = new Store(":memory:");
    const agent = store.createAgent({ name: "Alex", slug: "alex", harness: "scripted" });
    const connection = store.createConnection({ agentId: agent.id, platform: "feishu", secretRef: "s1" });
    const chat = store.upsertChat({ connectionId: connection.id, platformId: "oc_1", kind: options.kind ?? "group" });
    const other = store.upsertChat({ connectionId: connection.id, platformId: "oc_2", kind: "group" });
    const sends: OutboundMessage[] = [];
    const live = {
      capabilities: () => ({ maxTextLength: 4000, ...(options.mentions ? { mentions: true } : {}) }),
      send: async (message: OutboundMessage) => {
        sends.push(message);
        return { kind: "sent", platformId: `om_${sends.length}` };
      },
    } as unknown as ChannelConnection;
    const outbox = new Outbox(store, () => live, [0]);
    const send = (text: string) => outbox.send(agent.id, { chatId: chat.id, text });
    return { store, sends, send, connectionId: connection.id, chat, other };
  };

  it("mentions a bot by the name others mention it with", async () => {
    const { sends, send, connectionId } = setup();
    const pm = store.touchContact(connectionId, "ou_pm", "Mingle产品经理");
    const report = await send("@Mingle产品经理 想听你一句");
    expect(sends[0]?.mentions).toEqual([{ id: "ou_pm", name: "Mingle产品经理" }]);
    expect(report.mentioned).toEqual([{ contact: pm.id, name: "Mingle产品经理" }]);
    expect(report.unmatched).toEqual([]);
  });

  it("answers to the name given to a person too", async () => {
    const { sends, send, connectionId } = setup();
    const k = store.touchContact(connectionId, "ou_1", "zhang.san");
    store.setContactAlias(k.id, "张三");
    await send("@张三 看下");
    expect(sends[0]?.mentions?.[0]?.id).toBe("ou_1");
  });

  it("settles a shared name by who spoke in the chat, and otherwise mentions nobody", async () => {
    const { sends, send, connectionId, chat, other } = setup();
    store.touchContact(connectionId, "ou_a", "Bob");
    store.touchContact(connectionId, "ou_b", "Bob");
    let report = await send("@Bob hi");
    expect(sends[0]?.mentions).toBeUndefined();
    expect(report.unmatched).toEqual(["@Bob"]);

    const said = (chatId: string, platformId: string, senderId: string) =>
      store.insertInbound({
        chatId,
        platformId,
        senderId,
        senderName: "Bob",
        body: "hey",
        attachments: [],
        replyTo: null,
        triggers: false,
        createdAt: Date.now(),
      });
    said(other.id, "x1", "ou_a");
    said(chat.id, "x2", "ou_b");
    report = await send("@Bob hi");
    expect(sends[1]?.mentions).toEqual([{ id: "ou_b", name: "Bob" }]);
  });

  it("says when a name matched no one, and skips group-wide mentions", async () => {
    const { send } = setup();
    const report = await send("@Nobody 你好 @all");
    expect(report.unmatched).toEqual(["@Nobody"]);
  });

  it("says the names went out as plain text where the chat app has no mentions", async () => {
    const { send, connectionId } = setup({});
    store.touchContact(connectionId, "ou_pm", "PM");
    expect((await send("@PM hi")).degraded).toContain("mentions_plain");
  });

  it("does not look for mentions in a direct chat", async () => {
    const { sends, send, connectionId } = setup({ mentions: true, kind: "dm" });
    store.touchContact(connectionId, "ou_pm", "PM");
    const report = await send("@PM hi");
    expect(sends[0]?.mentions).toBeUndefined();
    expect(report.mentioned).toEqual([]);
  });
});
