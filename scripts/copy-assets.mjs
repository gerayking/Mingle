// Copy non-TypeScript files the code reads at run time (migrations, the agent guide, the console) into dist/.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const assets = [
  ["src/store/migrations", "dist/store/migrations"],
  ["src/cli/manual.md", "dist/cli/manual.md"],
  ["src/remote/bootstrap.mjs", "dist/remote/bootstrap.mjs"],
  ["scripts/install-remote.sh", "dist/remote/install-node.sh"],
];
for (const [from, to] of assets) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

rmSync("dist/web", { recursive: true, force: true });
if (existsSync("web/dist/index.html")) cpSync("web/dist", "dist/web", { recursive: true });
