import { existsSync, readFileSync } from "node:fs";
import { MingleError } from "../core/errors.ts";
import { spawnSsh, sshFailure } from "./ssh.ts";

/** Return only known failure categories, never arbitrary SSH output or environment values. */
function installFailure(stderr: string, code: number | null): MingleError {
  const ssh = sshFailure(stderr);
  if (code === 255 || ssh.code === "ssh_host_key") return ssh;
  const reason = /checksum mismatch|checksum list has no unique|Invalid SHA-256/i.test(stderr)
    ? "checksum"
    : /Could not download/i.test(stderr)
      ? "download"
      : /Supported hosts|Supported architectures|cannot run on this host/i.test(stderr)
        ? "unsupported"
        : /Install .+ on this host/i.test(stderr)
          ? "dependency"
          : /Another installation may be running/i.test(stderr)
            ? "busy"
            : /Refusing to replace|incomplete or incompatible runtime/i.test(stderr)
              ? "conflict"
              : "failed";
  return new MingleError(`ssh_install_${reason}`, "Remote environment installation failed. Check the host and retry.");
}

/** Runs the reviewed, bundled installer on the selected host; Node is not needed to start it. */
export async function installRemoteNode(
  host: string,
  signal: AbortSignal,
  timeoutMs = 15 * 60_000,
  run = spawnSsh,
): Promise<void> {
  signal.throwIfAborted();
  const bundled = new URL("../remote/install-node.sh", import.meta.url);
  const source = existsSync(bundled) ? bundled : new URL("../../scripts/install-remote.sh", import.meta.url);
  if (!existsSync(source)) throw new MingleError("ssh_runtime_missing", "Build Mingle before installing remotely.");
  const script = readFileSync(source);
  const child = run(host, ["sh", "-s", "--"]);
  return new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) {
        child.kill();
        reject(error);
      } else resolve();
    };
    const abort = () => finish(new MingleError("ssh_unavailable", "Mingle is stopping.", 503));
    const timer = setTimeout(
      () => finish(new MingleError("ssh_install_timeout", "Remote installation timed out. Check the host and retry.")),
      timeoutMs,
    );
    child.stdout.resume();
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-8192);
    });
    child.stdin.on("error", () => {});
    child.on("error", () => finish(sshFailure(stderr)));
    child.on("close", (code) => finish(code === 0 ? undefined : installFailure(stderr, code)));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else child.stdin.end(script);
  });
}
