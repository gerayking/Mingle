import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { MingleError } from "../core/errors.ts";

export function sshTarget(value: unknown): string {
  if (typeof value !== "string" || value.length > 255 || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]*$/.test(value)) {
    throw new MingleError("ssh_target_invalid", "Use an SSH config alias or user@host, without options or spaces.");
  }
  return value;
}

export function remoteHome(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    [...value].some((char) => char.charCodeAt(0) < 32) ||
    (!value.startsWith("/") && !value.startsWith("~/"))
  ) {
    throw new MingleError("ssh_home_invalid", "Use an absolute remote data directory, or a path starting with ~/.");
  }
  return value;
}

/** OpenSSH passes the remote command through a shell; quote every argument there as well. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function sshArgs(host: string, command: readonly string[]): string[] {
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "--",
    sshTarget(host),
    command.map(shellQuote).join(" "),
  ];
}

export function spawnSsh(host: string, command: readonly string[]): ChildProcessWithoutNullStreams {
  return spawn("ssh", sshArgs(host, command), { stdio: "pipe", windowsHide: true });
}

/** Find the private runtime without relying on an interactive shell or nvm. */
export function remoteNodeCommand(args: readonly string[]): string[] {
  return [
    "sh",
    "-c",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion.
    'mingle_node_prefix=${MINGLE_NODE_PREFIX:-"$HOME/.local/share/mingle"}; if [ -x "$mingle_node_prefix/node/bin/node" ]; then PATH="$mingle_node_prefix/node/bin:$PATH"; export PATH; fi; exec node "$@"',
    "mingle-node",
    ...args,
  ];
}

export function sshFailure(stderr: string): MingleError {
  if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr))
    return new MingleError("ssh_host_key", "Verify this host in a terminal with ssh before connecting from Mingle.");
  if (/permission denied|authentication failed/i.test(stderr))
    return new MingleError(
      "ssh_auth",
      "Sign in with ssh in a terminal first. Mingle uses your SSH config and ssh-agent.",
    );
  if (/node.*not found|requires Node|node version/i.test(stderr))
    return new MingleError(
      "ssh_node_missing",
      "Install Node.js 24 or newer on the remote host and make node available to SSH.",
    );
  return new MingleError(
    "ssh_unavailable",
    "Could not reach the remote Mingle service. Check SSH access and retry.",
    503,
  );
}
