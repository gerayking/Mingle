import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sshConfig from "../src/platform/ssh-config.ts";
import { rig } from "./helpers.ts";

describe("local SSH config discovery", () => {
  let userHome: string;
  function config(path: string, text: string) {
    const file = join(userHome, ".ssh", path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  }
  beforeEach(() => {
    userHome = mkdtempSync(join(tmpdir(), "mingle-ssh-config-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(userHome, { recursive: true, force: true });
  });

  it("lists concrete aliases without exposing or evaluating connection settings", async () => {
    const marker = join(userHome, "must-not-run");
    config(
      "config",
      `
# Host commented-out
Host dev staging !excluded *.example prod-?
  HostName private.example
  User private-user
  Port 2222
  IdentityFile ~/.ssh/private-key
  ProxyCommand touch ${marker}
HOST=DEV "quoted-alias" 'single-quoted'
Match exec "touch ${marker}"
  Host conditional
Host -oInjected
`,
    );
    expect(await sshConfig.readSshConfig(userHome)).toEqual({
      hosts: ["dev", "staging", "quoted-alias", "single-quoted", "conditional"],
      incomplete: true,
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("follows sorted includes, quotes, globs, home paths and nested relative paths", async () => {
    const absolute = config("absolute", "Host absolute\n").replaceAll("\\", "/");
    config("config", `Host first\nInclude conf.d/*.conf "with spaces" ~/extra.conf "${absolute}"\nHost last\n`);
    config("conf.d/b.conf", "Host second\nInclude nested\n");
    config("conf.d/a.conf", "Host included\n");
    config("nested", "Host nested\n");
    config("with spaces", "Host spaced\n");
    writeFileSync(join(userHome, "extra.conf"), "Host extra\n");
    expect(await sshConfig.readSshConfig(userHome)).toEqual({
      hosts: ["first", "included", "second", "nested", "spaced", "extra", "absolute", "last"],
      incomplete: false,
    });
  });

  it("allows missing config and unmatched includes, and rereads edits on refresh", async () => {
    expect(await sshConfig.readSshConfig(userHome)).toEqual({ hosts: [], incomplete: false });
    config("config", "Include absent/*.conf\nHost first\n");
    expect(await sshConfig.readSshConfig(userHome)).toEqual({ hosts: ["first"], incomplete: false });
    config("config", "Host changed\n");
    expect(await sshConfig.readSshConfig(userHome)).toEqual({ hosts: ["changed"], incomplete: false });
  });

  it("bounds recursive includes and reports partial results for invalid or oversized files", async () => {
    config("config", 'Host usable\nInclude cycle large %h/config\nHost "unfinished\n');
    config("cycle", "Include config\n");
    config("large", `Host hidden\n${"#".repeat(1024 * 1024)}`);
    expect(await sshConfig.readSshConfig(userHome)).toEqual({ hosts: ["usable"], incomplete: true });
  });

  it("reports an unreadable root instead of treating it as an empty config", async () => {
    mkdirSync(join(userHome, ".ssh/config"), { recursive: true });
    expect(await sshConfig.readSshConfig(userHome)).toEqual({ hosts: [], incomplete: true });
  });

  it("requires admin authentication and keeps config discovery local", async () => {
    const read = vi.spyOn(sshConfig, "readSshConfig").mockResolvedValue({ hosts: ["fixture"], incomplete: false });
    const local = await rig(async () => {});
    try {
      expect((await fetch(`${local.url}/v1/admin/ssh/config`)).status).toBe(401);
      expect(read).not.toHaveBeenCalled();
      expect(await local.admin("GET", "/v1/admin/ssh/config?path=/ignored")).toEqual({
        status: 200,
        json: { hosts: ["fixture"], incomplete: false },
      });
      expect(read).toHaveBeenCalledExactlyOnceWith();
      expect(local.mingle.remotes.list()).toEqual([]);
    } finally {
      await local.close();
    }
  });
});
