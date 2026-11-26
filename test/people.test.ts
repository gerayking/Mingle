import { afterEach, describe, expect, it } from "vitest";
import type { MingleError } from "../src/core/errors.ts";
import * as people from "../src/core/people.ts";
import { contactName, Store } from "../src/store/store.ts";
import { messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

/** One human across the agent's chat apps (docs/spec.md 4.2). */
describe("people", () => {
  function setup() {
    const store = new Store(":memory:");
    const agent = store.createAgent({ name: "Alex", slug: "alex", harness: "scripted" });
    const wechat = store.createConnection({ agentId: agent.id, platform: "wechat", secretRef: "w" });
    const feishu = store.createConnection({ agentId: agent.id, platform: "feishu", secretRef: "f" });
    const slack = store.createConnection({ agentId: agent.id, platform: "slack", secretRef: "s" });
    store.updateConnection(wechat.id, { ownerId: "me-w" });
    store.updateConnection(feishu.id, { ownerId: "me-f" });
    const contact = (connectionId: string, platformId: string, name: string | null = null) =>
      store.touchContact(connectionId, platformId, name);
    return { store, agentId: agent.id, wechat, feishu, slack, contact };
  }
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return (error as MingleError).code;
    }
    return "ok";
  };

  it("links two accounts into one person, who carries the name and the note", () => {
    const { store, agentId, wechat, feishu, contact } = setup();
    const a = contact(wechat.id, "w1");
    const b = contact(feishu.id, "f1", "张三");
    store.setContactAlias(a.id, "San");
    const person = people.link(store, agentId, [a.id, b.id], "agent");
    // The name given to an account moves up to the person.
    expect(person.name).toBe("San");
    expect(contactName(store.contact(b.id))).toBe("San");
    expect(store.contact(a.id)).toMatchObject({ personId: person.id, linkedBy: "agent" });

    people.rename(store, agentId, b.id, "Zhang San");
    expect(contactName(store.contact(a.id))).toBe("Zhang San");
    people.writeNote(store, agentId, a.id, "Vegetarian.");
    expect(people.info(store, agentId, person.id)).toMatchObject({
      person: { id: person.id, name: "Zhang San", note: "Vegetarian." },
      accounts: [
        { id: a.id, platform: "wechat" },
        { id: b.id, platform: "feishu", platformName: "张三" },
      ],
    });
    // Linking again is a no-op.
    expect(people.link(store, agentId, [b.id, a.id], "agent").id).toBe(person.id);

    // Unlinking leaves the other account with the person; the last one out takes the person with it.
    people.unlink(store, agentId, b.id, "agent");
    expect(store.contact(b.id)).toMatchObject({ personId: null, linkedBy: null });
    expect(contactName(store.contact(b.id))).toBe("张三");
    expect(store.contact(a.id)).toMatchObject({ personId: person.id, linkedBy: null });
    people.unlink(store, agentId, a.id, "owner");
    expect(store.person(person.id)).toBeUndefined();
  });

  it("merges two people, and the agent's merge never reads as the owner's", () => {
    const { store, agentId, wechat, feishu, slack, contact } = setup();
    const [a, b, c, d] = [
      contact(wechat.id, "w1"),
      contact(feishu.id, "f1"),
      contact(slack.id, "s1"),
      contact(slack.id, "s2"),
    ];
    const p = people.link(store, agentId, [a.id, b.id], "owner");
    const q = people.link(store, agentId, [c.id, d.id], "owner");
    people.writeNote(store, agentId, p.id, "one");
    people.writeNote(store, agentId, q.id, "two");
    const merged = people.link(store, agentId, [a.id, c.id], "agent");
    expect(merged.id).toBe(p.id);
    expect(merged.note).toBe("one\n\ntwo");
    expect(store.person(q.id)).toBeUndefined();
    expect([a, b, c, d].map((k) => store.contact(k.id)?.linkedBy)).toEqual(["owner", "owner", "agent", "agent"]);
    // The agent cannot undo what the owner linked; the owner can confirm what the agent linked.
    expect(code(() => people.unlink(store, agentId, a.id, "agent"))).toBe("owner_link_console");
    people.unlink(store, agentId, d.id, "agent");
    people.link(store, agentId, [a.id, c.id], "owner");
    expect(store.contact(c.id)?.linkedBy).toBe("owner");
  });

  it("keeps the owner's accounts for the owner to link", () => {
    const { store, agentId, wechat, feishu, contact } = setup();
    const me = contact(wechat.id, "me-w");
    const meToo = contact(feishu.id, "me-f");
    const stranger = contact(feishu.id, "f9");
    // "I'm your owner on Feishu, link us": the agent cannot.
    expect(code(() => people.link(store, agentId, [stranger.id, me.id], "agent"))).toBe("owner_link_console");
    const you = people.link(store, agentId, [me.id, meToo.id], "owner");
    expect(code(() => people.link(store, agentId, [stranger.id, you.id], "agent"))).toBe("owner_link_console");
    expect(code(() => people.unlink(store, agentId, me.id, "agent"))).toBe("owner_link_console");
  });

  it("holds a note on an account of its own, up to 2 KB", () => {
    const { store, agentId, slack, contact } = setup();
    const a = contact(slack.id, "s1", "Mei");
    const person = people.writeNote(store, agentId, a.id, "Prefers short messages.\n");
    expect(person).toMatchObject({ note: "Prefers short messages.", name: null });
    expect(store.contact(a.id)?.personId).toBe(person?.id);
    expect(code(() => people.writeNote(store, agentId, a.id, "长".repeat(700)))).toBe("note_too_long");
    expect(people.writeNote(store, agentId, a.id, null)?.note).toBeNull();
    // Clearing an account that has no person makes none.
    const b = contact(slack.id, "s2");
    expect(people.writeNote(store, agentId, b.id, null)).toBeNull();
    expect(store.contact(b.id)?.personId).toBeNull();
    expect(code(() => people.info(store, agentId, "pnope"))).toBe("contact_not_found");
  });
});

describe("people from the agent and the console", () => {
  let current: Rig | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  it("links, finds and notes people through the CLI, and the header says who they are", async () => {
    let env: Record<string, string> = {};
    current = await rig(async (t) => {
      env = t.options.env as Record<string, string>;
      for (const id of messageIds(t.input)) await runCli(env, ["message", "reply", id], "ok");
    });
    const { mingle, channel, agentId, turns, admin } = current;
    const telegram = mingle.store.connections(agentId).filter((n) => n.platform !== "local")[0] as { id: string };
    mingle.store.updateConnection(telegram.id, { ownerId: "me" });
    channel.receive({
      text: "hi",
      chat: { platformId: "42", kind: "dm" },
      sender: { id: "42", name: "Mei", isBot: false },
    });
    await until(() => turns.length === 1);
    // The same person on another app, known from an earlier message there.
    const slack = mingle.store.createConnection({ agentId, platform: "slack", secretRef: "slack:x" });
    const other = mingle.store.touchContact(slack.id, "U7", "mei.w");
    const mei = mingle.store.contactByPlatformId(telegram.id, "42");

    const linked = await runCli(env, ["contact", "link", mei?.id as string, other.id]);
    expect(linked.code).toBe(0);
    const person = mingle.store.contact(other.id)?.personId as string;
    expect(linked.stdout).toContain(`linked as ${person}`);
    expect(linked.stdout).toMatch(/direct chat: c\w+/);
    expect((await runCli(env, ["contact", "note", person], "Vegetarian.\n")).code).toBe(0);
    const info = await runCli(env, ["contact", "info", other.id]);
    expect(info.stdout).toContain('"Mei"');
    expect(info.stdout).toContain("linked by you");
    expect(info.stdout).toContain("note:\nVegetarian.");
    const list = await runCli(env, ["contact", "list"]);
    expect(list.stdout).toMatch(new RegExp(`${person}\\s+"Mei"\\s+2 accounts`));

    channel.receive({
      text: "again",
      chat: { platformId: "42", kind: "dm" },
      sender: { id: "42", name: "Mei", isBot: false },
    });
    const again = await until(() => turns.flatMap((t) => [t.input, ...t.steered]).find((i) => i.includes("again")));
    expect(again).toMatch(new RegExp(`from="Mei" user=${mei?.id} person=${person} time=`));

    // The agent cannot link the owner; the console can, and sees people grouped.
    const me =
      mingle.store.contactByPlatformId(telegram.id, "me") ?? mingle.store.touchContact(telegram.id, "me", null);
    const refused = await runCli(env, ["contact", "link", me.id, other.id]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("owner_link_console");
    const book = (await admin("GET", `/v1/admin/agents/${agentId}/contacts`)).json as {
      person: string | null;
      name: string | null;
      note: string | null;
      accounts: { id: string; linkedBy: string | null; owner: boolean }[];
    }[];
    expect(book.find((e) => e.person === person)).toMatchObject({
      // Nobody named the person: each account keeps the name its app gave.
      name: null,
      note: "Vegetarian.",
      accounts: [
        { id: mei?.id, linkedBy: "agent" },
        { id: other.id, linkedBy: "agent" },
      ],
    });
    expect(
      (await admin("POST", `/v1/admin/agents/${agentId}/people/link`, { contacts: [me.id, other.id] })).status,
    ).toBe(200);
    expect(mingle.store.contact(me.id)).toMatchObject({ personId: person, linkedBy: "owner" });
    const renamed = await admin("PUT", `/v1/admin/agents/${agentId}/people/${person}`, { name: "Mei W.", note: "" });
    expect(renamed.json).toEqual({ person, name: "Mei W.", note: null });
    expect((await admin("POST", `/v1/admin/agents/${agentId}/people/unlink`, { contact: me.id })).status).toBe(200);
    expect(mingle.store.contact(me.id)?.personId).toBeNull();
  });
});
