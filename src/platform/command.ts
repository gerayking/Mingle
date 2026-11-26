import { execFile, spawn } from "node:child_process";
import { join } from "node:path";

/** Why a command did not finish on its own. */
export type KillReason = "timeout" | "output_too_large" | "cancelled" | "spawn_failed";

export interface CommandResult {
  /** Exit code, or null when it was killed or could not start. */
  readonly code: number | null;
  /** What it printed; empty when the run was killed, so nothing half-collected leaks out. */
  readonly stdout: string;
  readonly killed?: KillReason;
}

export interface CommandOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** Aborts the command like a timeout does; the result says "cancelled". */
  readonly signal?: AbortSignal;
}

/** How long after a kill we still wait for `close` before letting the pipes go anyway. */
const KILL_GRACE_MS = 5_000;

/** Variables a check command may see: enough to find tools and behave, nothing per-agent or secret. */
const BASE_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TMP", "TEMP"];
const WINDOWS_ENV = [
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "SYSTEMDRIVE",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
];

/**
 * The environment a reminder's check command runs with (docs/spec.md 4.6): a fixed allowlist of
 * Mingle's own process variables — never the agent's secret variables, and never arbitrary
 * `process.env` entries (proxy variables can carry passwords, `*_KEY`/`*_TOKEN` credentials).
 * Windows variable names match case-insensitively (`Path`, `SystemRoot`). This is not a sandbox:
 * tools keep their own sign-in under HOME.
 */
export function checkEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const windows = platform === "win32";
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const name = windows ? key.toUpperCase() : key;
    const allowed = name.startsWith("LC_") || BASE_ENV.includes(name) || (windows && WINDOWS_ENV.includes(name));
    if (allowed) env[key] = value;
  }
  return env;
}

/**
 * Runs one shell command (/bin/sh on POSIX, cmd.exe on Windows) and collects its standard output;
 * standard error is drained and dropped, so nothing a command complains about is kept. On a
 * timeout, too much output or an abort the whole process tree is killed — a process group on
 * POSIX, `taskkill /T` on Windows — so a `curl` behind a pipe does not outlive it; a detached
 * descendant is best-effort only. The promise resolves even if descendants hold the pipes open
 * past a short grace. Never rejects.
 */
export function runCommand(command: string, options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    // Already cancelled: no process is ever started.
    if (options.signal?.aborted) {
      resolve({ code: null, stdout: "", killed: "cancelled" });
      return;
    }
    const posix = process.platform !== "win32";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        shell: true,
        cwd: options.cwd,
        env: options.env,
        // stderr goes nowhere: it can carry a tool's own secrets and is never kept.
        stdio: ["ignore", "pipe", "ignore"],
        // Its own process group, so a kill reaches everything the shell started.
        detached: posix,
        windowsHide: true,
      });
    } catch {
      resolve({ code: null, stdout: "", killed: "spawn_failed" });
      return;
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    let killed: KillReason | undefined;
    let done = false;
    let killTimer: NodeJS.Timeout | undefined;
    const taskkill = (pid: number) => {
      // Resolve under the native system root: PATH can be hijacked and the cwd is the agent's home.
      const root = process.env.SystemRoot ?? process.env.WINDIR;
      if (!root) {
        child.kill("SIGKILL");
        return;
      }
      execFile(
        join(root, "System32", "taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: KILL_GRACE_MS },
        // If taskkill itself could not run, at least take the direct child down.
        (error) => {
          if (error && child.exitCode === null) child.kill("SIGKILL");
        },
      );
    };
    const kill = (reason: KillReason) => {
      if (killed || done) return;
      killed = reason;
      if (child.exitCode === null) {
        try {
          if (posix && child.pid) {
            process.kill(-child.pid, "SIGKILL");
          } else if (!posix && child.pid) {
            // Kill the starting child's whole tree; by PID only, never by name.
            taskkill(child.pid);
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          child.kill("SIGKILL");
        }
      }
      // A descendant holding the pipe open must not hold the result: give close a moment, then
      // release the stream and finish with what we know.
      killTimer = setTimeout(() => {
        child.stdout?.destroy();
        finish(null);
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const timer = setTimeout(() => kill("timeout"), options.timeoutMs);
    const onAbort = () => kill("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > options.maxOutputBytes) kill("output_too_large");
      else out.push(chunk);
    });
    const finish = (code: number | null, spawnFailed?: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      const reason = killed ?? (spawnFailed ? ("spawn_failed" as const) : undefined);
      resolve({
        code: reason ? null : code,
        // Nothing half-collected leaves with a killed run.
        stdout: reason ? "" : Buffer.concat(out).toString("utf8"),
        ...(reason ? { killed: reason } : {}),
      });
    };
    child.on("error", () => finish(null, true));
    child.on("close", (code) => finish(code));
  });
}
