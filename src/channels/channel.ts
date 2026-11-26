/**
 * The contract every IM adapter implements. The core only knows these types;
 * platform SDKs stay inside `src/channels/<platform>/`.
 *
 * Design rules (docs/spec.md section 6):
 * - Semantics here, presentation in the adapter.
 * - Capabilities are reported per bot instance, not assumed per platform.
 * - An adapter never throws for "the platform cannot do this": it degrades and says so.
 */

import type { Mention } from "./mention.ts";

export type { Mention } from "./mention.ts";

export type Platform =
  | "wechat"
  | "wecom"
  | "feishu"
  | "dingtalk"
  | "qq"
  | "slack"
  | "discord"
  | "telegram"
  | "imessage"
  | "github"
  /** The owner's private chat in the Mingle console (docs/spec.md 6.9). Built in, not a chat app. */
  | "local";

export type ChatKind = "dm" | "group" | "thread";

/**
 * Who can reach a bot on this platform (docs/spec.md 4.7). `org`: only people inside the workspace
 * or organization the bot was created in (and who can add it to a group). `public`: anyone who
 * finds it can message it or add it to a group, so Mingle asks the owner before they reach the agent.
 * `owner`: the bot is the owner's own account (personal WeChat, iMessage self-chat), so only the
 * owner reaches it; anyone else who still does is asked about, as on a `public` platform.
 */
export type Trust = "org" | "public" | "owner";

/** What this bot instance can actually do right now, given its granted permissions. */
export interface Capabilities {
  readonly quoteReply: boolean;
  readonly reactions: boolean;
  readonly typingIndicator: boolean;
  readonly fileUpload: boolean;
  readonly fileDownload: boolean;
  readonly listMembers: boolean;
  /**
   * Turns `@name` into a real mention, from `OutboundMessage.mentions` (docs/spec.md 4.2). Absent:
   * the name goes out as plain text, which notifies nobody and wakes no bot.
   */
  readonly mentions?: true;
  /**
   * Can open a thread under a message by replying into it (`OutboundMessage.inThread`): a Feishu
   * "reply in thread", a Discord thread started from a message (docs/spec.md 4.13). Absent: such a
   * reply goes out as a plain quoted reply, as before.
   */
  readonly threads?: true;
  /** Largest text body one message can carry; longer bodies are split by the core. */
  readonly maxTextLength: number;
}

// ---------------------------------------------------------------- onboarding

/** How a user connects a bot on this platform. Drives the console's connect screen. */
export type OnboardingMethod =
  /** `desktopLink`: the QR's link also works when opened in a signed-in browser on this computer. */
  | { readonly kind: "qr"; readonly desktopLink?: boolean }
  /** A code the person enters on the platform's site while signed in as the bot's account (OAuth device flow). */
  | { readonly kind: "device" }
  | {
      readonly kind: "credentials";
      readonly fields: readonly CredentialField[];
      /** Where to create the bot, prefilled where the platform allows. `__MINGLE_AGENT_NAME__` becomes the agent's name, `__MINGLE_AGENT_HANDLE__` a lowercase handle made from it. */
      readonly setupUrl?: string;
    };

export interface CredentialField {
  readonly key: string;
  /** Message-catalog key for the label, not display text. */
  readonly labelKey: string;
  readonly secret: boolean;
}

/**
 * Something on this computer the person sets up before a channel can connect (iMessage: macOS
 * permissions), checked live while the connect screen is open. Checks never prompt the person.
 */
export interface SetupCheck {
  readonly id: string;
  /**
   * ok: done. missing: not done yet. denied: refused before, so only System Settings can change it.
   * unknown: cannot tell until an earlier check passes.
   */
  readonly state: "ok" | "missing" | "denied" | "unknown";
}

export interface ChannelSetup {
  check(): Promise<{
    readonly checks: readonly SetupCheck[];
    /** The app macOS grants the permissions to, as the person sees it in System Settings ("Mingle", "Terminal"). */
    readonly app?: string;
  }>;
  /** One step the person asked for from the console: open a settings pane, or ask for a permission now. */
  act(action: string): Promise<void>;
  readonly actions: readonly string[];
}

export type OnboardingEvent =
  | { readonly kind: "qr_ready"; readonly qrContent: string; readonly expiresAt: number }
  | { readonly kind: "scanned" }
  /** Device flow: the person enters `userCode` at `verificationUri`; the adapter waits for them. */
  | {
      readonly kind: "device_code";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly expiresAt: number;
    }
  /** The platform wants a code typed on this computer (shown on the phone). Answer through `context.awaitCode`. */
  | { readonly kind: "needs_code"; readonly retry?: boolean }
  | { readonly kind: "awaiting_approval"; readonly detailKey?: string }
  | {
      readonly kind: "succeeded";
      readonly credentials: Credentials;
      readonly bot: BotIdentity;
      /** The person who scanned, when the platform reports it. They become the bot's owner. */
      readonly ownerId?: string;
      /** The bot exists but an admin still has to approve or enable it. */
      readonly pendingApproval?: boolean;
    }
  | { readonly kind: "failed"; readonly code: OnboardingFailure };

export interface OnboardingContext {
  /** Used to name the bot where the platform lets us suggest one. */
  readonly agentName?: string;
  /** Resolves with the code the user types in the console after a `needs_code` event. */
  readonly awaitCode?: () => Promise<string>;
  /**
   * Credentials of this platform's bots already connected on this computer, newest first. Lets a
   * platform recognize a rebind instead of treating every scan as a new client. Read only on demand.
   */
  readonly knownCredentials?: () => Promise<readonly Credentials[]>;
  /**
   * Credentials of an already-connected bot being re-authorized (only where `Channel.reauthorize`
   * is set): the platform updates that app's grants instead of creating a new bot, and the result
   * rebinds the existing connection.
   */
  readonly reauthorize?: Credentials;
  /**
   * Optional permissions the owner turned on for this re-authorization (docs/spec.md 6.1). The app
   * asks for them on top of what it always asks for, and keeps those it was already granted.
   */
  readonly adding?: readonly PermissionId[];
}

export type OnboardingFailure =
  | "expired"
  | "denied"
  | "cancelled"
  | "invalid_credentials"
  /** The credentials work but lack a permission Mingle needs (a token without the right scopes). */
  | "insufficient_scope"
  | "network"
  | "already_bound"
  /** The platform says this account's bot is already connected here, to this computer's Mingle. */
  | "already_connected"
  /** The app or system denied something only the person can grant (macOS privacy settings, for example). */
  | "permission_missing"
  /** The app the channel drives is not signed in (Messages without iMessage, for example). */
  | "not_signed_in"
  | "unknown";

/** Opaque to the core. Stored in the system keychain, never in SQLite or logs. */
export type Credentials = Readonly<Record<string, string>>;

export interface BotIdentity {
  readonly id: string;
  readonly name: string;
  /**
   * The `Sender.id` this bot has in other bots' messages, where that is not `id` (GitHub: the login,
   * while `id` is the numeric user id). Lets the core recognize this computer's other agents.
   */
  readonly senderId?: string;
}

// ----------------------------------------------------------------- lifecycle

export type ConnectionState =
  | { readonly kind: "connecting" }
  | { readonly kind: "connected" }
  | { readonly kind: "reconnecting"; readonly attempt: number }
  | { readonly kind: "awaiting_approval" }
  | { readonly kind: "error"; readonly code: "credentials_revoked" | "permission_missing" | "network" | "unknown" };

// ----------------------------------------------------------------- messaging

export interface ChatRef {
  /** Platform chat id; for a thread or topic, the adapter encodes both ids here. */
  readonly platformId: string;
  readonly kind: ChatKind;
  readonly name?: string;
  /**
   * For a thread: the group it belongs to, where the adapter stores the messages around it
   * that were not addressed to the bot. The agent reads them there (docs/spec.md 4.2).
   */
  readonly parent?: { readonly platformId: string; readonly name?: string };
  /**
   * A thread that is one conversation (a Discord thread), not a lasting place of its own (a Telegram
   * forum topic, a GitHub issue): once the agent has spoken in it, what people say there next is
   * addressed to it, as in a conversation, without an @ each time (docs/spec.md 4.2).
   */
  readonly followUp?: true;
}

export interface Sender {
  readonly id: string;
  readonly name: string;
  readonly isBot: boolean;
}

export interface InboundAttachment {
  /** Handle the adapter can later resolve to bytes. */
  readonly id: string;
  readonly name: string;
  readonly size?: number;
  readonly mime?: string;
}

export interface InboundMessage {
  readonly platformId: string;
  readonly chat: ChatRef;
  readonly sender: Sender;
  /** Plain text with the bot's own mention removed and other mentions rendered as @name. */
  readonly text: string;
  readonly attachments: readonly InboundAttachment[];
  /** Platform id of the message this one quotes or replies to. */
  readonly replyTo?: string;
  /** True when the bot was @-mentioned, or the message replies to one the bot sent. */
  readonly addressedToBot: boolean;
  /**
   * The text itself @-mentions the bot by name. A reply to the bot, a direct message, or a mention
   * the platform adds on its own (a reply ping) does not count. Other bots wake the agent only this
   * way (docs/spec.md 4.2). Leave it out where the platform cannot tell; the core then counts a group
   * message addressed to the bot as a mention.
   */
  readonly mentioned?: boolean;
  /**
   * The others the text @-mentions, as the platform reports them. The core adds them to the address
   * book, so the agent can mention them back by name, other bots included.
   */
  readonly mentions?: readonly Sender[];
  readonly sentAt: number;
  /**
   * Read from the chat's history when the bot joined, not delivered as it was sent. The core keeps
   * it as background and never answers it, whatever it @-mentions (docs/spec.md 4.2).
   */
  readonly earlier?: true;
}

export interface OutboundMessage {
  readonly chat: ChatRef;
  /** Markdown. The adapter renders it the platform's way. */
  readonly text: string;
  /** Platform id of the message to quote. Ignored, and reported, where unsupported. */
  readonly replyTo?: string;
  readonly files?: readonly { readonly path: string; readonly name?: string }[];
  /**
   * People the text @-mentions by name. Where `Capabilities.mentions`, the adapter writes each spot
   * `mentionSpots` finds as a real mention; elsewhere the text goes out as written.
   */
  readonly mentions?: readonly Mention[];
  /**
   * Reply to `replyTo` in a thread under it, opening one if it has none (where `Capabilities.threads`).
   * `title` names the thread where the platform names threads. The result's `thread` is where the
   * reply landed. Where a thread cannot be opened after all, it goes out as a quoted reply and
   * reports `thread_dropped`.
   */
  readonly inThread?: { readonly title: string };
  /**
   * This reply is an outcome the whole chat should see, not only those following a thread under
   * `replyTo` (a line's result, docs/spec.md 4.13). Where a reply to `replyTo` would land in its
   * thread (Feishu, once one is open under it), it goes out as a message of its own in the chat;
   * where a thread reply can also show in the channel (Slack), it does both. Elsewhere ignored.
   */
  readonly inChat?: true;
}

export type SendResult =
  | {
      readonly kind: "sent";
      readonly platformId: string;
      readonly degraded?: readonly Degradation[];
      /**
       * The chat's own ID, when it was addressed another way: a direct chat opened by the person's
       * ID (`openDirect`) on a platform that names the chat only once a message is in it.
       */
      readonly chat?: string;
      /** The thread the message went into, when it opened one (`OutboundMessage.inThread`). */
      readonly thread?: ChatRef;
    }
  /** The platform refused. `retryable` says whether trying again can help. */
  | {
      readonly kind: "failed";
      readonly code: "rate_limited" | "forbidden" | "too_large" | "chat_gone" | "network" | "unknown";
      readonly retryable: boolean;
      /** The platform's own error code, for the agent and the owner to act on. Never a secret. */
      readonly detail?: string;
      /**
       * The text is out and only the files failed. A retry must send the files alone, or the
       * person sees the text twice. `platformId` is the text's message.
       */
      readonly textSent?: { readonly platformId: string };
    }
  /** The request left but no answer came back. Never retried automatically. */
  | { readonly kind: "uncertain" };

/** A failure after the text went out: mark it so retries send the files alone. */
export function withTextSent(result: SendResult, textPlatformId: string): SendResult {
  return textPlatformId && result.kind === "failed" ? { ...result, textSent: { platformId: textPlatformId } } : result;
}

export type Degradation =
  | "quote_dropped"
  | "files_dropped"
  | "markdown_flattened"
  | "text_split"
  /** Asked for a thread (`OutboundMessage.inThread`), sent as a quoted reply: none could be opened. */
  | "thread_dropped"
  /** `@name`s went out as plain text: the chat app has no mention a bot can write. */
  | "mentions_plain";

// ------------------------------------------------------------------- adapter

export interface ChannelEvents {
  onMessage(message: InboundMessage): void;
  onState(state: ConnectionState): void;
  /** The bot was added to or removed from a chat. */
  onMembership(change: { readonly chat: ChatRef; readonly joined: boolean }): void;
}

export type ReactionState = "processing" | "done" | "error" | "none";

export interface LiveOptions {
  /** Platform ID of the message being answered. */
  readonly replyTo: string;
  /** Platform user ID to @-mention in the final answer (groups). */
  readonly mention?: string;
  /** First content, shown at once. Markdown. */
  readonly initial: string;
}

export interface LiveReply {
  /**
   * When the platform stops taking updates to this reply, if it does (WeCom's stream window).
   * Before then Mingle closes it with a note and sends the answer as a message of its own, so
   * the reply does not stay frozen on its last progress.
   */
  readonly until?: number;
  /** Replace the progress content. Markdown. Best effort. */
  update(markdown: string): Promise<void>;
  /** Replace the content with the final answer and close the reply. `mentions` as in `OutboundMessage`. */
  finish(markdown: string, mentions?: readonly Mention[]): Promise<SendResult>;
}

/** One adapter instance per platform. Stateless across bots. */
export interface Channel {
  readonly platform: Platform;
  readonly onboarding: OnboardingMethod;
  /** For QR platforms: fields for binding an existing app by hand instead of scanning. */
  readonly manualFields?: readonly CredentialField[];
  /** Where to create the app for `manualFields` on the platform's developer site. */
  readonly manualSetupUrl?: string;
  /** Local prerequisites the console checks live before connecting. */
  readonly setup?: ChannelSetup;
  /**
   * This platform's onboarding can add permissions to an already-connected bot: starting it with
   * `OnboardingContext.reauthorize` carrying the connection's credentials updates that app rather
   * than making a new one.
   */
  readonly reauthorize?: boolean;
  /** Where the owner adds a connected bot to a server or group, for platforms where that is a separate step. */
  inviteUrl?(bot: BotIdentity): string;
  /**
   * Its bots can be sent every message in their groups, not only those that @ them (where the
   * platform asks for one, given the `group_messages` permission), so a group can be set to hear
   * everything (docs/spec.md 4.2). Absent where the platform only delivers what @s the bot.
   */
  readonly groupMessages?: true;
  /** Who can reach its bots. Absent means `public`: the safe side for a platform not described here. */
  readonly trust?: Trust;
  /** False where nobody can message the bot directly (GitHub), so nobody claims it that way. */
  readonly directMessages?: false;
  /** A link that opens a direct chat with the bot with `/start <code>` ready to send (Telegram). */
  claimUrl?(bot: BotIdentity, code: string): string;
  /**
   * Built into Mingle rather than a chat app (the console's private chat, docs/spec.md 6.9): every
   * agent has exactly one such connection, made by Mingle, with no credentials, no onboarding and
   * no owner to claim. It is not listed among the agent's chat apps.
   */
  readonly builtin?: true;

  /** Start connecting a new bot. Yields progress until `succeeded` or `failed`. */
  onboard(
    input: Credentials | undefined,
    signal: AbortSignal,
    context?: OnboardingContext,
  ): AsyncIterable<OnboardingEvent>;

  /** Open a live connection for one bot. */
  connect(credentials: Credentials, events: ChannelEvents): Promise<ChannelConnection>;
}

/** A live connection for one bot. */
export interface ChannelConnection {
  readonly bot: BotIdentity;
  /** Talks only in the owner's own chat (iMessage self-chat): no groups, nobody else. */
  readonly ownerOnly?: boolean;
  capabilities(): Capabilities;

  send(message: OutboundMessage): Promise<SendResult>;
  /**
   * The reaction on the person's message: processing while the agent works, done once
   * it answers, error if the turn failed, none to clear it. Best effort; never throws.
   */
  react(chat: ChatRef, platformMessageId: string, state: ReactionState): Promise<void>;
  /**
   * Open a reply that can be rewritten in place (a streaming card, or a message edited
   * as progress comes in). Absent where the platform cannot edit what it sent.
   */
  startLive?(chat: ChatRef, options: LiveOptions): Promise<LiveReply>;
  /** Best effort; never throws. */
  setTyping(chat: ChatRef, typing: boolean): Promise<void>;

  download(attachment: InboundAttachment, toPath: string): Promise<void>;
  /**
   * Open a direct conversation with a user by sending the first message. Where the platform allows it.
   * Reports the direct chat's ID, as its incoming messages name it, and the sent message's ID, so
   * Mingle can keep the line with the chat; `undefined` when the platform does not say.
   */
  messageUser?(userId: string, text: string): Promise<{ chat: string; platformId?: string } | undefined>;
  /**
   * The ID to send to for a direct chat with this user, when they have not messaged the bot yet
   * (docs/spec.md 5.3). Absent where the platform lets a bot write only to people who wrote first;
   * throws when the platform refuses this user. A platform that names the chat only once a message
   * is in it may return the user's ID, and reports the chat's own ID on the first send (`chat`).
   */
  openDirect?(userId: string): Promise<string>;
  listMembers(chat: ChatRef): Promise<readonly Sender[]>;
  /**
   * Permissions the owner can grant this bot on the platform, read live (docs/spec.md 4.2). Absent
   * where the platform has none to grant. Best effort; never throws, leaves out what it cannot tell.
   */
  permissions?(): Promise<readonly BotPermission[]>;
  /**
   * Where this person sits in the organization, in one line ("Product · Product manager"), where
   * the platform says and the owner turned member profiles on. Undefined when it cannot tell.
   * Best effort; never throws.
   */
  profile?(userId: string): Promise<string | undefined>;

  close(): Promise<void>;
}

/**
 * A permission the owner grants a bot on the platform itself.
 * `group_messages`: every message in the bot's groups, not only the ones that @ it; on Feishu also
 * the group's earlier messages.
 * `bot_messages`: what other bots send in the bot's groups. Feishu only; other platforms do not
 * report it.
 * `doc_comments`: comments in documents shared with the bot, so people can @ it there and it answers
 * in the comment thread (Feishu, docs/spec.md 6.8).
 * `member_profiles`: the department and title of the people the bot meets, so the agent knows who
 * is who in the organization (Feishu).
 */
export type PermissionId = "group_messages" | "bot_messages" | "doc_comments" | "member_profiles";

export interface BotPermission {
  readonly id: PermissionId;
  readonly granted: boolean;
  /**
   * Not asked for when the bot is created: the owner turns it on later from the bot's settings,
   * which keeps connecting simple (docs/spec.md 6.1).
   */
  readonly optional?: boolean;
  /**
   * How the owner grants it on the platform's site. Absent where it cannot be granted there, or
   * where the console grants it itself (`Channel.reauthorize`). `url` opens the platform's page with the change prefilled where the
   * platform allows; `steps` picks the console's instructions for that page (`permission.steps.<steps>`).
   */
  readonly grant?: { readonly url: string; readonly steps?: string };
}
