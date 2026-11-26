// Package portable source/build assets; dependencies are installed for the remote host's platform.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const stage = mkdtempSync(join(tmpdir(), "mingle-remote-package-"));
try {
  cpSync("dist", join(stage, "dist"), { recursive: true, filter: (path) => !path.endsWith("ssh-runtime.tgz") });
  const files = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "LICENSE"];
  if (existsSync("patches")) files.push("patches");
  for (const file of files) cpSync(file, join(stage, file), { recursive: true });
  execFileSync("tar", ["-czf", resolve("dist/ssh-runtime.tgz"), "-C", stage, "dist", ...files], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
} finally {
  rmSync(stage, { recursive: true, force: true });
}
