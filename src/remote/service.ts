import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** This supervisor is detached from SSH. Losing the managing computer leaves it running. */
export async function supervise(home: string, entry: string): Promise<void> {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = join(home, "ssh-service.json");
  // An OS-released SQLite lock avoids stale PID files and simultaneous setup races.
  const lockPath = join(home, "ssh-service.sqlite");
  const lease = new DatabaseSync(lockPath);
  chmodSync(lockPath, 0o600);
  try {
    lease.exec("BEGIN EXCLUSIVE");
  } catch {
    lease.close();
    return;
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid, entry }), { mode: 0o600 });
  let stopping = false;
  let child: ReturnType<typeof spawn> | undefined;
  const abort = new AbortController();
  const stop = () => {
    stopping = true;
    abort.abort();
    child?.kill("SIGTERM");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  let failures = 0;
  try {
    while (!stopping) {
      const log = openSync(join(home, "ssh-service.log"), "a", 0o600);
      const started = Date.now();
      child = spawn(process.execPath, [entry, "start", "--no-open", "--login-shell-env", "--port", "0"], {
        env: { ...process.env, MINGLE_HOME: home },
        // stdout carries a console token. Never retain it in the service log.
        stdio: ["ignore", "ignore", log],
      });
      closeSync(log);
      await new Promise<void>((resolve) => {
        child?.once("exit", () => resolve());
        child?.once("error", () => resolve());
      });
      child = undefined;
      if (Date.now() - started > 60_000) failures = 0;
      if (!stopping)
        await delay(Math.min(30_000, 1000 * ++failures), undefined, { signal: abort.signal }).catch(() => {});
    }
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    rmSync(lock, { force: true });
    lease.close();
  }
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const home = process.argv[2];
  if (!home) throw new Error("remote data directory required");
  await supervise(
    home,
    fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../cli/main.ts" : "../cli/main.js", import.meta.url)),
  );
}
