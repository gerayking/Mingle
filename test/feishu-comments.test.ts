import { describe, expect, it } from "vitest";
import type { ChannelEvents, InboundMessage } from "../src/channels/channel.ts";
import { flatten, parseThread, replyElements, threadId } from "../src/channels/feishu/comments.ts";
import { FEISHU_SCOPES, type FeishuApi, feishuChannel, type LarkChannelLike } from "../src/channels/feishu/feishu.ts";
import { until } from "./helpers.ts";

const BOT = "ou_bot";
const PM = "ou_pm_human";
const OTHER = "ou_zhang";

type Element = { type: string; text_run?: { text: string }; person?: { user_id: string }; docs_link?: { url: string } };
type ReplyItem = { reply_id: string; user_id: string; create_time: number; content: { elements: Element[] } };

const text = (t: string): Element => ({ type: "text_run", text_run: { text: t } });
const person = (id: string): Element => ({ type: "person", person: { user_id: id } });

/** A Feishu with one docx and its comment threads, as the drive v1 comment APIs answer. */
function fakeDocs() {
  const threads = new Map<string, { quote: string; replies: ReplyItem[] }>();
  const created: { fileToken: string; commentId: string; fileType: string; elements: Element[] }[] = [];
  const handlers = new Map<string, (arg: unknown) => unknown>();
  let unreadable = false;
  let failCreate: number | undefined;
  const channel = {
    async connect() {},
    async disconnect() {},
    on(name: string, handler: (arg: unknown) => unknown) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    async send() {
      throw new Error("a comment reply must not go out as a chat message");
    },
    async addReaction() {
      throw new Error("no reactions on comments");
    },
    async removeReaction() {},
    async getChatInfo() {
      return {};
    },
    rawClient: {
      contact: {
        v3: {
          user: {
            async get({ path }: { path: { user_id: string } }) {
              const names: Record<string, string> = { [PM]: "王五", [OTHER]: "张云杨" };
              return { data: { user: { name: names[path.user_id] } } };
            },
          },
        },
      },
      drive: {
        v1: {
          meta: {
            async batchQuery() {
              return {
                data: {
                  metas: [{ title: "Mingle 发布软文", url: "https://example.feishu.cn/docx/doxTOKEN" }],
                },
              };
            },
          },
          fileComment: {
            async batchQuery({ data }: { data: { comment_ids: string[] } }) {
              if (unreadable)
                throw Object.assign(new Error("403"), { response: { status: 403, data: { code: 1069303 } } });
              const id = data.comment_ids[0] as string;
              const thread = threads.get(id);
              return {
                data: {
                  items: thread
                    ? [
                        {
                          comment_id: id,
                          quote: thread.quote,
                          has_more: false,
                          reply_list: { replies: thread.replies },
                        },
                      ]
                    : [],
                },
              };
            },
          },
          fileCommentReply: {
            async list({ path }: { path: { comment_id: string } }) {
              return { data: { items: threads.get(path.comment_id)?.replies ?? [], has_more: false } };
            },
            async create({
              path,
              params,
              data,
            }: {
              path: { file_token: string; comment_id: string };
              params: { file_type: string };
              data: { content: { elements: Element[] } };
            }) {
              if (failCreate) {
                const code = failCreate;
                failCreate = undefined;
                throw Object.assign(new Error("400"), { response: { status: 400, data: { code } } });
              }
              created.push({
                fileToken: path.file_token,
                commentId: path.comment_id,
                fileType: params.file_type,
                elements: data.content.elements,
              });
              const reply_id = `r_out_${created.length}`;
              threads.get(path.comment_id)?.replies.push({
                reply_id,
                user_id: BOT,
                create_time: 1_800_000_000 + created.length,
                content: data.content,
              });
              return { data: { reply_id } };
            },
          },
        },
      },
    },
    botIdentity: { openId: BOT, name: "Thomas the PM" },
  } as unknown as LarkChannelLike;
  return {
    channel,
    threads,
    created,
    emit: (name: string, arg: unknown) => handlers.get(name)?.(arg),
    unreadable: (on: boolean) => {
      unreadable = on;
    },
    failCreate: (code: number) => {
      failCreate = code;
    },
  };
}

const api: FeishuApi = {
  async register() {
    throw new Error("unused");
  },
  async botInfo() {
    return { name: "Thomas the PM", openId: BOT, activated: true };
  },
  async scopes() {
    return new Map();
  },
};

async function connect() {
  const docs = fakeDocs();
  const received: InboundMessage[] = [];
  const events: ChannelEvents = { onMessage: (m) => received.push(m), onState: () => {}, onMembership: () => {} };
  const connection = await feishuChannel({ api, createChannel: () => docs.channel }).connect(
    { appId: "cli_1", appSecret: "s" },
    events,
  );
  return { docs, received, connection };
}

/** What the SDK's normalizeComment makes of a drive.notice.comment_add_v1 event. */
function commentEvent(partial: { commentId: string; replyId?: string; from: string; mentioned: boolean }) {
  return {
    fileToken: "doxTOKEN",
    fileType: "docx",
    commentId: partial.commentId,
    ...(partial.replyId ? { replyId: partial.replyId } : {}),
    operator: { openId: partial.from },
    mentionedBot: partial.mentioned,
    timestamp: 1_800_000_000_000,
  };
}

describe("feishu document comments (MING-126)", () => {
  it("subscribes to comment events and asks to read and reply to comments when the app is created", () => {
    expect(FEISHU_SCOPES).toEqual(
      expect.arrayContaining([
        "docs:document.comment:read",
        "docs:document.comment:create",
        "drive:drive.metadata:readonly",
      ]),
    );
  });

  it("answers an @ in a reply to the bot's own comment, with the thread it had not seen", async () => {
    const { docs, received, connection } = await connect();
    // The agent commented with another tool, outside Mingle; then someone @-mentions it in a reply.
    docs.threads.set("c1", {
      quote: "业务方在内部工单系统 modio 里提需求",
      replies: [
        {
          reply_id: "r1",
          user_id: BOT,
          create_time: 1_799_999_000,
          content: { elements: [text("「内部工单系统 modio」拼写建议核对：是「Modio」还是别的正式名称？")] },
        },
        {
          reply_id: "r2",
          user_id: OTHER,
          create_time: 1_800_000_000,
          content: { elements: [person(BOT), text(" 原文里面是什么？")] },
        },
      ],
    });
    await docs.emit("comment", commentEvent({ commentId: "c1", replyId: "r2", from: OTHER, mentioned: true }));
    await until(() => received.length === 1, 2000);
    const message = received[0] as InboundMessage;
    expect(message).toMatchObject({
      platformId: "r2",
      chat: {
        platformId: "doc:docx:doxTOKEN:c1",
        kind: "thread",
        name: "Mingle 发布软文 · “业务方在内部工单系统 modio 里提需求”",
        // One conversation: once the agent answered, replies there need no @ (docs/spec.md 6.8).
        followUp: true,
      },
      sender: { id: OTHER, name: "张云杨", isBot: false },
      addressedToBot: true,
      mentioned: true,
      sentAt: 1_800_000_000_000,
    });
    expect(message.text).toBe(
      [
        "> Comment thread in “Mingle 发布软文” (https://example.feishu.cn/docx/doxTOKEN)",
        "> On the text: “业务方在内部工单系统 modio 里提需求”",
        "> Thomas the PM (you): 「内部工单系统 modio」拼写建议核对：是「Modio」还是别的正式名称？",
        "",
        "原文里面是什么？",
      ].join("\n"),
    );

    // The answer goes into the same thread, as a comment reply, with a real @-mention.
    const result = await connection.send({
      chat: message.chat,
      text: "@张云杨 原文写的是 **modio**，见 `工单系统` 文档。",
      replyTo: "r2",
      mentions: [{ id: OTHER, name: "张云杨" }],
    });
    expect(result).toEqual({ kind: "sent", platformId: "r_out_1", degraded: ["markdown_flattened"] });
    expect(docs.created).toEqual([
      {
        fileToken: "doxTOKEN",
        commentId: "c1",
        fileType: "docx",
        elements: [person(OTHER), text(" 原文写的是 modio，见 工单系统 文档。")],
      },
    ]);

    // A later @ in the same thread brings only what the agent has not seen yet.
    docs.threads.get("c1")?.replies.push(
      { reply_id: "r3", user_id: PM, create_time: 1_800_000_100, content: { elements: [text("我也确认一下")] } },
      {
        reply_id: "r4",
        user_id: OTHER,
        create_time: 1_800_000_200,
        content: { elements: [person(BOT), text(" 那就改成 Modio")] },
      },
    );
    await docs.emit("comment", commentEvent({ commentId: "c1", replyId: "r4", from: OTHER, mentioned: true }));
    await until(() => received.length === 2, 2000);
    expect(received[1]?.text).toBe(
      [
        "> Comment thread in “Mingle 发布软文” (https://example.feishu.cn/docx/doxTOKEN)",
        "> On the text: “业务方在内部工单系统 modio 里提需求”",
        "> 王五: 我也确认一下",
        "",
        "那就改成 Modio",
      ].join("\n"),
    );
    await connection.close();
  });

  it("keeps replies that do not @ the bot as background, and ignores its own", async () => {
    const { docs, received, connection } = await connect();
    docs.threads.set("c2", {
      quote: "",
      replies: [
        { reply_id: "r1", user_id: BOT, create_time: 1, content: { elements: [text("建议改个标题")] } },
        { reply_id: "r2", user_id: OTHER, create_time: 2, content: { elements: [text("好的，我来改")] } },
      ],
    });
    await docs.emit("comment", commentEvent({ commentId: "c2", replyId: "r1", from: BOT, mentioned: false }));
    await docs.emit("comment", commentEvent({ commentId: "c2", replyId: "r2", from: OTHER, mentioned: false }));
    await until(() => received.length === 1, 2000);
    expect(received[0]).toMatchObject({
      platformId: "r2",
      text: "好的，我来改",
      addressedToBot: false,
      mentioned: false,
      chat: { name: "Mingle 发布软文" },
    });
    await connection.close();
  });

  it("still tells the agent it was asked when it cannot read the document", async () => {
    const { docs, received, connection } = await connect();
    docs.unreadable(true);
    await docs.emit("comment", commentEvent({ commentId: "c3", replyId: "r9", from: OTHER, mentioned: true }));
    await until(() => received.length === 1, 2000);
    expect(received[0]).toMatchObject({ platformId: "r9", addressedToBot: true });
    expect(received[0]?.text).toContain("could not read this comment");
    await connection.close();
  });

  it("does not react, stream or list members in a comment thread, and maps refusals", async () => {
    const { docs, connection } = await connect();
    docs.threads.set("c4", { quote: "", replies: [] });
    const chat = { platformId: "doc:docx:doxTOKEN:c4", kind: "thread" as const };
    await connection.react(chat, "r1", "processing");
    await expect(connection.startLive?.(chat, { replyTo: "r1", initial: "…" })).rejects.toThrow();
    expect(await connection.listMembers(chat)).toEqual([]);
    expect(await connection.send({ chat, text: "", files: [{ path: "/nope.png" }] })).toMatchObject({
      kind: "failed",
      detail: "files_unsupported",
    });
    docs.failCreate(1069303);
    expect(await connection.send({ chat, text: "hi" })).toEqual({
      kind: "failed",
      code: "forbidden",
      retryable: false,
      detail: "feishu_1069303",
    });
    docs.failCreate(1069304);
    expect(await connection.send({ chat, text: "hi" })).toMatchObject({ kind: "failed", code: "chat_gone" });
    expect(await connection.send({ chat, text: "hi", files: [{ path: "/a.png" }] })).toMatchObject({
      kind: "sent",
      degraded: ["files_dropped"],
    });
    await connection.close();
  });
});

describe("feishu comment helpers", () => {
  it("round-trips the thread's chat ID", () => {
    const thread = { fileType: "docx", fileToken: "doxTOKEN", commentId: "123" };
    expect(parseThread(threadId(thread))).toEqual(thread);
    expect(parseThread("oc_123")).toBeUndefined();
  });

  it("flattens Markdown to the plain text a comment shows", () => {
    expect(flatten("## 结论\n**改成** `Modio`，见 [文档](https://x.cn/a)")).toBe(
      "结论\n改成 Modio，见 文档 https://x.cn/a",
    );
    expect(replyElements("纯文本", undefined)).toEqual({ elements: [text("纯文本")], flattened: false });
  });
});
