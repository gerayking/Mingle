/** A user-owned Mingle service managed through the computer's SSH client. */
export interface RemoteHost {
  id: string;
  host: string;
  home: string;
  runtime: string;
}

export interface RemoteInstallJob {
  id: string;
  host: string;
  home: string;
  state: "running" | "done" | "failed";
  phase: "installing" | "preparing";
  result?: RemoteHost;
  error?: string;
}

export interface RemoteLocation {
  id: string;
  host: string;
  reachable: boolean;
}

export const REMOTE_ID = /^ssh_[a-f0-9]{12}$/;

export function remoteId(host: string, id: string): string {
  return `${host}~${id}`;
}

export function splitRemoteId(value: string): { host: string; id: string } | undefined {
  const at = value.indexOf("~");
  if (at < 0 || !REMOTE_ID.test(value.slice(0, at))) return;
  return { host: value.slice(0, at), id: value.slice(at + 1) };
}

/** Namespaces identifiers used outside an agent-specific route. Nested contact/message IDs stay local. */
export function remoteAgent(
  host: RemoteHost,
  value: Record<string, unknown>,
  reachable = true,
): Record<string, unknown> {
  return {
    ...value,
    id: remoteId(host.id, String(value.id)),
    slug: remoteId(host.id, String(value.slug)),
    harness: remoteId(host.id, String(value.harness)),
    avatar: value.avatar ? `/v1/ssh-avatars/${host.id}/${String(value.avatar).split("/").at(-1)}` : null,
    remote: { id: host.id, host: host.host, reachable } satisfies RemoteLocation,
    connections: Array.isArray(value.connections)
      ? value.connections.map((connection: Record<string, unknown>) => ({
          ...connection,
          id: remoteId(host.id, String(connection.id)),
        }))
      : [],
  };
}
