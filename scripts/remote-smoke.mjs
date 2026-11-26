// After pnpm build: smoke-test the actual portable archive using local dependencies and pipes.
// No SSH hosts, package registries, real agents or chat accounts are contacted.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RpcClient } from "../dist/remote/wire.js";

const stage = mkdtempSync(join(tmpdir(), "mingle-remote-smoke-"));
const home = join(stage, "data");
let supervisor;
let control;
try {
  execFileSync("tar", ["-xzf", resolve("dist/ssh-runtime.tgz"), "-C", stage]);
  assert.ok(existsSync(join(stage, "dist/web/index.html")));
  assert.ok(existsSync(join(stage, "dist/remote/bootstrap.mjs")));
  assert.ok(!existsSync(join(stage, "dist/ssh-runtime.tgz")));
  symlinkSync(resolve("node_modules"), join(stage, "node_modules"), "dir");
  mkdirSync(home, { mode: 0o700 });
  supervisor = spawn(process.execPath, [join(stage, "dist/remote/service.js"), home], {
    stdio: "ignore",
    detached: true,
  });
  const runtimeFile = join(home, "runtime.json");
  for (let i = 0; i < 200 && !existsSync(runtimeFile); i++) await delay(100);
  assert.ok(
    existsSync(runtimeFile),
    `Remote startup failed: ${existsSync(join(home, "ssh-service.log")) ? readFileSync(join(home, "ssh-service.log"), "utf8") : "supervisor did not start"}`,
  );
  const runtime = JSON.parse(readFileSync(runtimeFile, "utf8"));
  control = spawn(process.execPath, [join(stage, "dist/remote/control.js"), home], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const rpc = new RpcClient(control.stdout, control.stdin);
  const result = await rpc.request({ method: "GET", path: "/v1/admin/status" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.agents, []);
  assert.ok(!JSON.stringify(result).includes(runtime.adminToken));
  rpc.close();
  await once(control, "exit");
  assert.equal((await fetch(`${runtime.url}/v1/health`)).status, 200);
  assert.ok(!readFileSync(join(home, "ssh-service.log"), "utf8").includes(runtime.adminToken));
  console.log(`Remote archive ${result.body.version}: starts, serves management RPC, and survives control EOF.`);
} finally {
  control?.kill();
  if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
    supervisor.kill("SIGTERM");
    await once(supervisor, "exit");
  }
  rmSync(stage, { recursive: true, force: true });
}
