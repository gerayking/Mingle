import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnosisPrompt } from "../src/core/diagnose.ts";
import { tailLog } from "../src/core/logs.ts";
import { desktopLogFile } from "../src/platform/logs.ts";
import { VERSION } from "../src/version.ts";
import { CLI_ENTRY, messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

/** Diagnosing a problem with a local agent, and the log it reads (docs/spec.md 4.11, MING-84). */

let current: Rig | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await current?.close();
  current = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mingle-log-"));
  dirs.push(dir);
  return dir;
}

/** The owner's CLI outside any agent session, with its own home folder so no real desktop log is read. */
function ownerCli(mingleHome: string, userHome: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, MINGLE_HOME: mingleHome, HOME: userHome, USERPROFILE: userHome };
  delete env.MINGLE_TOKEN;
  delete env.MINGLE_API;
  delete env.XDG_CONFIG_HOME;
  env.APPDATA = join(userHome, "AppData", "Roaming");
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [CLI_ENTRY, ...args], { env }, (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

describe("diagnosis prompt", () => {
  it("carries the diagnostics and asks for an issue the owner approves, not a fix", async () => {
    current = await rig(async (t) => {
      for (const id of messageIds(t.input))
        await runCli(t.options.env as Record<string, string>, ["message", "reply", id], "ok");
    });
    const { mingle, channel, agentId, admin } = current;
    channel.receive({ text: "the secret word is pumpkin" });
    await until(() => channel.sent.length === 1 && !mingle.runtime(agentId)?.busy);

    const result = await admin("GET", `/v1/admin/agents/${agentId}/diagnosis-prompt`);
    expect(result.status).toBe(200);
    const text = (result.json as { text: string }).text;
    expect(text).toContain("Mingle diagnostic info\n");
    expect(text).toContain(`agent: ${agentId} · status idle`);
    expect(text).toContain(`"${mingle.cliPath}" log --agent ${agentId}`);
    expect(text).toContain(`git checkout v${VERSION}`);
    expect(text).toContain("gh issue create --repo earayu/Mingle");
    expect(text).toContain("do not open a pull request");
    expect(text).toContain("file it only after they agree");
    expect(text).not.toContain("pumpkin");
  });

  it("writes the commands for PowerShell on Windows", () => {
    const text = diagnosisPrompt(
      { id: "a1", name: "Alex" },
      "Mingle diagnostic info\n",
      "C:\\m\\mingle.cmd",
      "1.0.0",
      "win32",
    );
    expect(text).toContain('& "C:\\m\\mingle.cmd" log --agent a1');
    expect(text).toContain("```powershell");
  });
});

describe("log", () => {
  it("keeps the last lines and, for an agent, only those naming it as a word", () => {
    const file = join(tempDir(), "mingle.log");
    writeFileSync(
      file,
      [
        "t1 Mingle listening",
        "t2 a1: delivered m1",
        "t3 connection n9 stopped",
        "t4 Al paused",
        "t5 already up",
        "",
      ].join("\n"),
    );
    expect(tailLog(file, 2)).toEqual(["t4 Al paused", "t5 already up"]);
    expect(tailLog(file, 10, ["a1", "Al", "n9"])).toEqual([
      "t2 a1: delivered m1",
      "t3 connection n9 stopped",
      "t4 Al paused",
    ]);
    expect(tailLog(join(dirname(file), "missing.log"), 10)).toBeUndefined();
  });

  it("finds the desktop app's log where mygo puts it", () => {
    expect(desktopLogFile("darwin", {}, "/Users/x")).toBe(join("/Users/x", "Library", "Logs", "Mingle", "mingle.log"));
    expect(desktopLogFile("linux", {}, "/home/x")).toBe(join("/home/x", ".config", "Mingle", "logs", "mingle.log"));
    expect(desktopLogFile("linux", { XDG_CONFIG_HOME: "/cfg" }, "/home/x")).toBe(
      join("/cfg", "Mingle", "logs", "mingle.log"),
    );
    expect(desktopLogFile("win32", { APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, "C:\\Users\\x")).toBe(
      join("C:\\Users\\x\\AppData\\Roaming", "Mingle", "logs", "mingle.log"),
    );
  });

  it("reads the log with Mingle stopped, and the desktop app's error output after it", async () => {
    const home = tempDir();
    const user = tempDir();
    mkdirSync(join(home, "logs"));
    writeFileSync(join(home, "logs", "mingle.log"), "t1 Mingle listening\nt2 a1: delivered m1\nt3 stopping\n");
    const crash = desktopLogFile(process.platform, { APPDATA: join(user, "AppData", "Roaming") }, user);
    mkdirSync(dirname(crash), { recursive: true });
    writeFileSync(crash, "TypeError: boom\n    at x (main.js:1:1)\n");

    const all = await ownerCli(home, user, ["log", "--lines", "2"]);
    expect(all.code).toBe(0);
    expect(all.stdout).toContain("last 2 lines\nt2 a1: delivered m1\nt3 stopping\n");
    expect(all.stdout).toContain("desktop app, Mingle's error output");
    expect(all.stdout).toContain("TypeError: boom");

    const mine = await ownerCli(home, user, ["log", "--agent", "a1"]);
    expect(mine.stdout).toContain("mentioning a1\nt2 a1: delivered m1\n");
    expect(mine.stdout).not.toContain("t3 stopping");

    const bad = await ownerCli(home, user, ["log", "--lines", "0"]);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("invalid_lines");
  });

  it("asks a running Mingle what the log calls the agent, its connections included", async () => {
    current = await rig(async () => {});
    const { mingle, agentId, home, url } = current;
    const connection = mingle.store.connections(agentId).filter((n) => n.platform !== "local")[0]?.id as string;
    writeFileSync(join(home, "runtime.json"), JSON.stringify({ url, adminToken: mingle.adminToken }));
    writeFileSync(
      join(home, "logs", "mingle.log"),
      `t1 connection ${connection} stopped (credentials_missing)\nt2 Alex paused\nt3 connection nother stopped\n`,
    );
    const result = await ownerCli(home, tempDir(), ["log", "--agent", "alex", "--json"]);
    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as { lines: string[]; desktop: unknown };
    expect(json.lines).toEqual([`t1 connection ${connection} stopped (credentials_missing)`, "t2 Alex paused"]);
    expect(json.desktop).toBeNull();
  });
});
