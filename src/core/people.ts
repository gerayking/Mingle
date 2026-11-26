import type { Platform } from "../channels/channel.ts";
import { type Contact, contactName, type LinkedBy, type Person, type Store } from "../store/store.ts";
import { MingleError, notFound } from "./errors.ts";

/**
 * People: one human across the agent's chat apps (docs/spec.md 4.2). Links are explicit only, and
 * a link never carries permissions it was not given: what the agent links shares a name, a note and
 * where to find them, nothing more. The owner's own accounts are linked by the owner alone, so no
 * one can talk the agent into making them "the owner" elsewhere.
 */

/** A note is a few lines about someone, not a file: 2 KB of UTF-8. */
export const NOTE_MAX_BYTES = 2048;

export interface Account extends Contact {
  readonly platform: Platform;
  readonly owner: boolean;
}

/** Everyone who is one of this agent's contacts, with where they belong. */
function accounts(store: Store, agentId: string): Account[] {
  return store.agentContacts(agentId);
}

/**
 * A contact (u…) or a person (p…) of this agent, as the accounts it stands for. `contact` is the
 * account named, when a contact ID was given.
 */
export function resolve(
  store: Store,
  agentId: string,
  id: string,
): { person: Person | undefined; contact: Account | undefined; accounts: Account[] } {
  const all = accounts(store, agentId);
  const contact = all.find((k) => k.id === id);
  const personId = contact ? contact.personId : id;
  const person = personId ? store.agentPerson(agentId, personId) : undefined;
  if (!contact && !person) throw notFound("contact", id);
  return {
    person,
    contact,
    accounts: person ? all.filter((k) => k.personId === person.id) : [contact as Account],
  };
}

const ownerOnly = () =>
  new MingleError(
    "owner_link_console",
    "only your owner links or unlinks their own accounts, and undoes links they made, in the Mingle console",
    403,
  );

/**
 * Link two contacts (or people) as the same human. `agent` links are refused where they touch the
 * owner: an owner's account, or a person holding one.
 */
export function link(store: Store, agentId: string, ids: readonly string[], by: LinkedBy): Person {
  if (ids.length < 2)
    throw new MingleError("contacts_required", "name two contacts to link: mingle contact link <user> <user>");
  const sides = ids.map((id) => resolve(store, agentId, id));
  if (by === "agent" && sides.some((s) => s.accounts.some((k) => k.owner))) throw ownerOnly();
  // A person named by its ID stands for its first account; a contact for itself.
  const picked = sides.map((s) => (s.contact ?? s.accounts[0]) as Account);
  const personIds = new Set(sides.map((s, i) => s.person?.id ?? `-${picked[i]?.id}`));
  // Already one person: the agent has nothing to add. The owner linking them confirms the link as theirs.
  if (personIds.size === 1 && sides[0]?.person && (by === "agent" || picked.every((k) => k.linkedBy === "owner"))) {
    return sides[0].person;
  }
  return store.linkContacts(
    agentId,
    picked.map((k) => k.id),
    by,
  );
}

/** Take a contact out of its person. The agent cannot undo a link the owner made. */
export function unlink(store: Store, agentId: string, contactId: string, by: LinkedBy): void {
  const contact = accounts(store, agentId).find((k) => k.id === contactId);
  if (!contact) throw notFound("contact", contactId);
  if (by === "agent" && (contact.linkedBy === "owner" || contact.owner)) throw ownerOnly();
  store.unlinkContact(contactId);
}

/**
 * Write the note on whoever `id` is; a contact on its own gets a person to hold it. Null clears it,
 * and clearing a contact that has no person changes nothing (null comes back).
 */
export function writeNote(store: Store, agentId: string, id: string, note: string | null): Person | null {
  const { person, accounts: found } = resolve(store, agentId, id);
  const text = note?.replace(/\s+$/, "") || null;
  if (text && Buffer.byteLength(text, "utf8") > NOTE_MAX_BYTES) {
    throw new MingleError(
      "note_too_long",
      `keep the note under ${NOTE_MAX_BYTES} bytes (about 600 Chinese or 2000 English characters); put longer notes in notes/`,
    );
  }
  if (!person && !text) return null;
  const target = person ?? store.ensurePerson(agentId, (found[0] as Account).id);
  return store.updatePerson(target.id, { note: text }) as Person;
}

/** Name whoever `id` is: the person when there is one, else the contact. */
export function rename(store: Store, agentId: string, id: string, name: string | null): void {
  const { person, accounts: found } = resolve(store, agentId, id);
  if (person) store.updatePerson(person.id, { name });
  else store.nameContact((found[0] as Account).id, name);
}

/** What `mingle contact info` shows: the name, the note, and each account with where to reach it. */
export function info(store: Store, agentId: string, id: string) {
  const { person, accounts: found } = resolve(store, agentId, id);
  return {
    person: person ? { id: person.id, name: person.name, note: person.note } : null,
    accounts: found.map((k) => ({
      id: k.id,
      platform: k.platform,
      name: contactName(k),
      platformName: k.name,
      owner: k.owner,
      bot: k.isBot && !k.owner,
      linkedBy: k.linkedBy,
      profile: k.profile,
      chats: store.contactChats(k).map((c) => ({ id: c.id, kind: c.kind, name: c.name, lastAt: c.lastAt })),
    })),
  };
}
