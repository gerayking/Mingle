import type { ChannelConnection, Platform } from "../channels/channel.ts";
import { type Chat, contactName, type Store } from "../store/store.ts";
import { MingleError } from "./errors.ts";
import * as people from "./people.ts";

/**
 * Where `mingle message send --to` goes (docs/spec.md 5.3): a chat ID as it is, or a person by
 * their contact or person ID, in their direct chat with the bot. The direct chat is opened on the
 * first send where the platform lets a bot write first, the way a person messages a colleague
 * they have only met in a group.
 */
export async function sendTarget(
  store: Store,
  live: (connectionId: string) => ChannelConnection | undefined,
  agentId: string,
  to: string,
): Promise<string> {
  if (store.agentChat(agentId, to)) return to;
  const { accounts, contact } = people.resolve(store, agentId, to);
  const reachable = accounts.filter((k) => direct(store, k) !== undefined);
  // A person named by person ID: the account they already talk to the agent on, else their only one.
  const account = contact ?? (reachable.length > 0 ? reachable[0] : accounts.length === 1 ? accounts[0] : undefined);
  if (!account) {
    throw new MingleError(
      "contact_ambiguous",
      `${to} has accounts on several chat apps (${accounts.map((k) => `${k.id} ${k.platform}`).join(", ")}); send to one of them with --to <contact-id>`,
    );
  }
  const existing = direct(store, account);
  if (existing) return existing.id;

  const connection = store.connection(account.connectionId);
  const platform = connection?.platform as Platform;
  const conn = live(account.connectionId);
  const name = contactName(account) ?? account.id;
  if (!conn) {
    throw new MingleError(
      "not_connected",
      `the ${platform ?? "chat app"} connection is offline; it reconnects on its own, try again in a minute`,
      503,
    );
  }
  if (!conn.openDirect) {
    throw new MingleError(
      "direct_unavailable",
      `${platform} lets a bot message only people who messaged it first, and ${name} has not. ` +
        "Reach them in a group you share, or tell whoever asked that they need to message you first. " +
        "Do not write to them through another account on this computer",
      422,
    );
  }
  let platformId: string;
  try {
    platformId = await conn.openDirect(account.platformId);
  } catch (error) {
    const detail = (error as Error).message;
    throw new MingleError(
      "direct_refused",
      `${platform} would not open a direct chat with ${name}${detail ? ` (${detail})` : ""}. ` +
        "The bot may not be allowed to reach them; reach them in a group you share, or tell whoever asked. " +
        "Do not write to them through another account on this computer",
      502,
    );
  }
  return store.upsertChat({
    connectionId: account.connectionId,
    platformId,
    kind: "dm",
    ...(account.name ? { name: account.name } : {}),
    peerId: account.platformId,
  }).id;
}

/** The direct chat already open with this account, by who it is with or who has written in it. */
function direct(store: Store, account: people.Account): Chat | undefined {
  return (
    store.directChat(account.connectionId, account.platformId) ??
    store.contactChats(account, 1).find((c) => c.kind === "dm")
  );
}
