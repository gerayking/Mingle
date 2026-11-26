// Executed by the remote user's Node.js through SSH. stdin is a verified application archive.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Mingle requires Node.js 24");
const requested = process.argv[1];
const digest = process.argv[2];
if (!requested || !/^[a-f0-9]{64}$/.test(digest ?? "")) throw new Error("invalid setup parameters");
const home = resolve(requested.startsWith("~/") ? join(homedir(), requested.slice(2)) : requested);
if (!isAbsolute(home) || home === "/" || home === homedir()) throw new Error("choose a dedicated data directory");
const root = join(homedir(), ".cache", "mingle", "ssh", digest);
const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 32 * 1024 * 1024) throw new Error("runtime archive too large");
  chunks.push(chunk);
}
const archive = Buffer.concat(chunks);
if (createHash("sha256").update(archive).digest("hex") !== digest) throw new Error("runtime checksum mismatch");
if (!existsSync(join(root, ".ready"))) {
  mkdirSync(join(root, ".."), { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(root, "..", ".install-"));
  try {
    const tar = join(stage, "runtime.tgz");
    writeFileSync(tar, archive, { mode: 0o600 });
    const unpack = spawnSync("tar", ["-xzf", tar, "-C", stage], { stdio: ["ignore", "ignore", "inherit"] });
    if (unpack.status !== 0) throw new Error("could not unpack remote runtime");
    rmSync(tar);
    const install = spawnSync(
      "npm",
      [
        "exec",
        "--yes",
        "--package=pnpm@11.7.0",
        "--",
        "pnpm",
        "install",
        "--prod",
        "--frozen-lockfile",
        "--ignore-scripts",
      ],
      {
        cwd: stage,
        stdio: ["ignore", "ignore", "inherit"],
        timeout: 240_000,
      },
    );
    if (install.status !== 0) throw new Error("could not install remote dependencies");
    writeFileSync(join(stage, ".ready"), digest);
    // The archive and its dependencies are immutable after publication.
    try {
      renameSync(stage, root);
    } catch (error) {
      if (!existsSync(join(root, ".ready"))) throw error;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
mkdirSync(home, { recursive: true, mode: 0o700 });
chmodSync(home, 0o700);
async function healthy() {
  try {
    const runtime = JSON.parse(readFileSync(join(home, "runtime.json"), "utf8"));
    const url = new URL(runtime.url);
    return (
      url.hostname === "127.0.0.1" &&
      url.protocol === "http:" &&
      (await fetch(`${url.origin}/v1/health`, { signal: AbortSignal.timeout(1500) })).ok
    );
  } catch {
    return false;
  }
}
if (!(await healthy())) {
  const log = openSync(join(home, "ssh-service.log"), "a", 0o600);
  const child = spawn(process.execPath, [join(root, "dist/remote/service.js"), home], {
    detached: true,
    stdio: ["ignore", "ignore", log],
    env: process.env,
  });
  closeSync(log);
  child.unref();
  for (let i = 0; i < 100 && !(await healthy()); i++) await delay(300);
}
if (!(await healthy())) throw new Error("remote service did not become ready; inspect ssh-service.log on the host");
console.log(JSON.stringify({ home, runtime: root }));
