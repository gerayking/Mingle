import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installRemoteNode } from "../src/platform/remote-install.ts";
import { remoteNodeCommand, shellQuote, sshArgs } from "../src/platform/ssh.ts";
import { REMOTE_INSTALL_COMMAND } from "../web/src/remote-install.ts";

// The installer targets POSIX remote hosts; its local shell fixture needs a POSIX runner.
describe.skipIf(process.platform === "win32")("remote environment installer", () => {
  let root: string;
  let prefix: string;
  let fixtures: string;
  let env: NodeJS.ProcessEnv;
  const name = "node-v24.22.3-linux-x64";
  const script = resolve("scripts/install-remote.sh");
  const run = (...args: string[]) =>
    spawnSync("sh", [script, "--prefix", prefix, ...args], { env, encoding: "utf8", timeout: 10_000 });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mingle-installer-"));
    prefix = join(root, "a 'quoted' $(false) prefix");
    fixtures = join(root, "fixtures");
    const bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(join(fixtures, name, "bin"), { recursive: true });
    // Exercise the real extraction and checksum code with a tiny local archive.
    writeFileSync(
      join(fixtures, name, "bin/node"),
      `#!/bin/sh\nif [ "$1" = --version ]; then echo v24.22.3; else exec ${shellQuote(process.execPath)} "$@"; fi\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(fixtures, name, "bin/npm"), "#!/bin/sh\nnode --version >/dev/null && echo 11.0.0\n", {
      mode: 0o755,
    });
    expect(spawnSync("tar", ["-czf", join(fixtures, `${name}.tar.gz`), "-C", fixtures, name]).status).toBe(0);
    const digest = createHash("sha256")
      .update(readFileSync(join(fixtures, `${name}.tar.gz`)))
      .digest("hex");
    writeFileSync(join(fixtures, "SHASUMS256.txt"), `${digest}  ${name}.tar.gz\n`);
    writeFileSync(join(bin, "uname"), '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n', {
      mode: 0o755,
    });
    writeFileSync(join(bin, "node"), "#!/bin/sh\necho old-system-node >&2\nexit 1\n", { mode: 0o755 });
    writeFileSync(
      join(bin, "curl"),
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(root, "download.mjs"))} "$@"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(root, "download.mjs"),
      `
      import { copyFileSync, appendFileSync } from 'node:fs';
      import { basename, join } from 'node:path';
      const args = process.argv.slice(2);
      const url = args.at(-1);
      if (!url.startsWith('https://nodejs.org/dist/v24.22.3/')) process.exit(2);
      appendFileSync(join(process.env.INSTALL_FIXTURES, 'requests'), url + '\\n');
      if (process.env.INSTALL_DOWNLOAD_FAIL) process.exit(22);
      copyFileSync(join(process.env.INSTALL_FIXTURES, basename(url)), args[args.indexOf('--output') + 1]);
    `,
    );
    env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      INSTALL_FIXTURES: fixtures,
      MINGLE_NODE_PREFIX: prefix,
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("installs through SSH stdin and reuses a private runtime even with an old node on PATH", async () => {
    await installRemoteNode("fixture", new AbortController().signal, 10_000, (host, command) => {
      expect(host).toBe("fixture");
      expect(command).toEqual(["sh", "-s", "--"]);
      // Only the transport is substituted. Run the actual bundled script on a local fixture host.
      return spawn("sh", ["-c", sshArgs(host, command).at(-1) ?? ""], { env, stdio: "pipe" });
    });
    expect(readlinkSync(join(prefix, "node"))).toBe(join(prefix, name));
    const requests = readFileSync(join(fixtures, "requests"), "utf8");
    expect(requests.trim().split("\n")).toHaveLength(2);
    expect(run().status).toBe(0);
    expect(readFileSync(join(fixtures, "requests"), "utf8")).toBe(requests);

    const args = [
      "--input-type=module",
      "-e",
      'import { readFileSync } from "node:fs"; console.log(JSON.stringify({arg:process.argv[1],stdin:readFileSync(0,"utf8")}))',
      "a 'quoted' $(false); argument",
    ];
    const remote = sshArgs("fixture", remoteNodeCommand(args)).at(-1) ?? "";
    const result = spawnSync("sh", ["-c", remote], { env, input: "archive bytes", encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ arg: args.at(-1), stdin: "archive bytes" });
    expect(readdirSync(prefix).some((file) => file.startsWith(".node-install"))).toBe(false);
  });

  it("classifies installer and SSH failures without returning raw remote output", async () => {
    for (const [message, exitCode, code] of [
      ["Could not download Node.js; private-secret", 1, "ssh_install_download"],
      ["Node.js checksum mismatch; private-secret", 1, "ssh_install_checksum"],
      ["Install tar on this host, then retry; private-secret", 1, "ssh_install_dependency"],
      ["Supported architectures: x64 or arm64", 1, "ssh_install_unsupported"],
      ["Another installation may be running", 1, "ssh_install_busy"],
      ["Refusing to replace a non-symlink directory", 1, "ssh_install_conflict"],
      ["Permission denied (publickey); private-secret", 255, "ssh_auth"],
      ["Host key verification failed", 255, "ssh_host_key"],
      ["mkdir: permission denied; private-secret", 1, "ssh_install_failed"],
    ] as const) {
      const result = installRemoteNode("fixture", new AbortController().signal, 10_000, () =>
        spawn(
          process.execPath,
          [
            "-e",
            `process.stdin.resume();process.stderr.write(${JSON.stringify(message)});process.exitCode=${exitCode}`,
          ],
          { stdio: "pipe" },
        ),
      );
      await expect(result).rejects.toMatchObject({ code });
      await expect(result).rejects.not.toThrow("private-secret");
    }
  });

  it("times out or aborts a stalled SSH process and handles a missing ssh executable", async () => {
    let child: ReturnType<typeof spawn> | undefined;
    const stalled = () => {
      // Keep a child alive after stdin closes, without starting any remote connection.
      const running = spawn("sh", ["-c", "cat >/dev/null; exec sleep 30"], { stdio: "pipe" });
      child = running;
      return running;
    };
    await expect(installRemoteNode("fixture", new AbortController().signal, 50, stalled)).rejects.toMatchObject({
      code: "ssh_install_timeout",
    });
    expect(child?.killed).toBe(true);
    const abort = new AbortController();
    const pending = installRemoteNode("fixture", abort.signal, 10_000, stalled);
    const rejected = expect(pending).rejects.toMatchObject({ code: "ssh_unavailable" });
    abort.abort();
    await rejected;
    expect(child?.killed).toBe(true);
    await expect(
      installRemoteNode("fixture", new AbortController().signal, 1000, () =>
        spawn("/nonexistent/mingle-test-ssh", [], { stdio: "pipe" }),
      ),
    ).rejects.toMatchObject({ code: "ssh_unavailable" });
  });

  it("rejects corrupt downloads and keeps an existing runtime selected", () => {
    mkdirSync(prefix);
    symlinkSync("previous-runtime", join(prefix, "node"));
    writeFileSync(join(fixtures, `${name}.tar.gz`), "corrupt archive");
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checksum mismatch");
    expect(readlinkSync(join(prefix, "node"))).toBe("previous-runtime");
    expect(existsSync(join(prefix, name))).toBe(false);
    expect(readdirSync(prefix)).toEqual(["node"]);
  });

  it("never executes an incomplete installer download from the copied command", () => {
    const marker = join(root, "must-not-run");
    writeFileSync(
      join(root, "bin/curl"),
      `#!/bin/sh\nfor output do :; done\nprintf '%s\\n' ${shellQuote(`touch ${shellQuote(marker)}`)} > "$output"\nexit 22\n`,
      { mode: 0o755 },
    );
    const result = spawnSync("sh", ["-c", REMOTE_INSTALL_COMMAND], { env, encoding: "utf8" });
    expect(result.status).toBe(22);
    expect(existsSync(marker)).toBe(false);
  });

  it("fails on download errors without publishing a partial installation", () => {
    env.INSTALL_DOWNLOAD_FAIL = "1";
    expect(run().status).not.toBe(0);
    expect(readdirSync(prefix)).toEqual([]);
  });

  it("does not overwrite an unmanaged directory or a concurrent installation", () => {
    mkdirSync(join(prefix, "node"), { recursive: true });
    writeFileSync(join(prefix, "node", "keep"), "user data");
    expect(run().stderr).toContain("Refusing to replace");
    expect(readFileSync(join(prefix, "node", "keep"), "utf8")).toBe("user data");
    mkdirSync(join(prefix, ".node-install-lock"));
    expect(run().stderr).toContain("Another installation");
    expect(existsSync(join(prefix, ".node-install-lock"))).toBe(true);
  });

  it("rejects an unsupported architecture and unsafe prefixes before downloading", () => {
    writeFileSync(join(root, "bin/uname"), '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo unsupported;; esac\n', {
      mode: 0o755,
    });
    expect(run().stderr).toContain("Supported architectures");
    expect(existsSync(join(fixtures, "requests"))).toBe(false);
    expect(run("--prefix", "/").status).not.toBe(0);
    expect(run("--prefix", "relative").status).not.toBe(0);
  });
});
