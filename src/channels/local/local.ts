import { randomBytes } from "node:crypto";
import { copyFile } from "node:fs/promises";
import type { Channel, ChannelEvents, Credentials, OnboardingEvent } from "../channel.ts";

/**
 * The owner's private chat with an agent in the Mingle console (docs/spec.md 6.9). Not a chat app:
 * Mingle makes one connection per agent, with no credentials, and the console posts into it through
 * `post`. Answers need nothing from the adapter: the outbox keeps every message the agent sends,
 * and the console reads the chat from there.
 */

/** The one chat of a local connection, and the one person in it. */
export const LOCAL_CHAT = "owner";
export const LOCAL_OWNER = "owner";

/** A file the owner attached in the console, already saved on this computer. */
export interface LocalFile {
  readonly path: string;
  readonly name: string;
  readonly size?: number;
  readonly mime?: string;
}

export interface LocalChannel extends Channel {
  /**
   * The owner said something in the console. Returns the message's platform ID, or undefined when
   * that connection is not open (it opens with Mingle, so only while starting or stopping).
   */
  post(
    connectionId: string,
    message: { readonly text: string; readonly files: readonly LocalFile[] },
  ): string | undefined;
}

export function localChannel(): LocalChannel {
  const open = new Map<string, ChannelEvents>();
  let seq = 0;
  const nextId = () => `l${Date.now().toString(36)}${(seq++).toString(36)}${randomBytes(3).toString("hex")}`;
  return {
    platform: "local",
    builtin: true,
    // Only the owner can open the console.
    trust: "owner",
    onboarding: { kind: "credentials", fields: [] },
    // Mingle makes these connections itself; there is nothing to onboard.
    async *onboard(): AsyncIterable<OnboardingEvent> {
      yield { kind: "failed", code: "unknown" };
    },
    async connect(credentials: Credentials, events: ChannelEvents) {
      const connectionId = credentials.connection;
      if (!connectionId) throw new Error("a local chat opens with its connection id");
      open.set(connectionId, events);
      return {
        bot: { id: connectionId, name: "Mingle" },
        ownerOnly: true,
        capabilities: () => ({
          quoteReply: true,
          reactions: false,
          typingIndicator: false,
          fileUpload: true,
          fileDownload: true,
          listMembers: false,
          maxTextLength: 100_000,
        }),
        async send() {
          return { kind: "sent" as const, platformId: nextId() };
        },
        async react() {},
        async setTyping() {},
        async download(attachment, toPath) {
          // The console saved the file under Mingle's home; its path is the attachment's handle.
          await copyFile(attachment.id, toPath);
        },
        async listMembers() {
          return [];
        },
        async close() {
          if (open.get(connectionId) === events) open.delete(connectionId);
        },
      };
    },
    post(connectionId, message) {
      const events = open.get(connectionId);
      if (!events) return undefined;
      const platformId = nextId();
      events.onMessage({
        platformId,
        chat: { platformId: LOCAL_CHAT, kind: "dm" },
        sender: { id: LOCAL_OWNER, name: LOCAL_OWNER, isBot: false },
        text: message.text,
        attachments: message.files.map((f) => ({
          id: f.path,
          name: f.name,
          ...(f.size !== undefined ? { size: f.size } : {}),
          ...(f.mime ? { mime: f.mime } : {}),
        })),
        addressedToBot: true,
        sentAt: Date.now(),
      });
      return platformId;
    },
  };
}
