import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "../src/harness/harness.ts";
import { type Rig, rig, until } from "./helpers.ts";

/**
 * Does a real harness hand long work to a line (docs/spec.md 4.13)? Opt-in: it spends quota.
 *
 *   MINGLE_E2E_LINES=claude,codex pnpm vitest run test/e2e-lines.test.ts
 *
 * One agent, one group, three asks in a row: a quick question it should answer itself, a coding
 * fix it should hand to a line (`task run`), and a fresh message asking about that fix, which it
 * should pass on (`task tell`). Prints every session's turns and commands, so a failure shows what
 * the model did instead.
 */
const targets = (process.env.MINGLE_E2E_LINES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const at = entry.indexOf(":");
    return at === -1 ? { id: entry } : { id: entry.slice(0, at), model: entry.slice(at + 1) || undefined };
  });

interface Turn {
  session: string;
  started: number;
  ended?: number;
  actions: string[];
}

/** Records each session's turns and the commands in them; a line's session runs outside the home. */
function recorder(turns: Turn[], home: () => string): (h: Harness) => Harness {
  return (harness) => ({
    ...harness,
    open: async (options, events) => {
      const session = options.cwd.startsWith(home()) && !options.cwd.includes("/lines/") ? "main" : "line";
      let current: Turn | undefined;
      return harness.open(options, {
        ...events,
        onTurnStarted: (self) => {
          current = { session, started: Date.now(), actions: [] };
          turns.push(current);
          events.onTurnStarted(self);
        },
        onTurnEnded: (outcome) => {
          if (current) current.ended = Date.now();
          events.onTurnEnded(outcome);
        },
        onAction: (tool, input) => {
          current?.actions.push(`${tool}: ${(input ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
          events.onAction?.(tool, input);
        },
      });
    },
  });
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "mingle-slug-"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "slug", version: "1.2.0", type: "module" }, null, 2));
  writeFileSync(
    join(dir, "slug.js"),
    `// Turn a title into a URL slug.\nexport function slugify(title) {\n  return title\n    .toLowerCase()\n    .replace(/[^a-z]+/g, "-")\n    .replace(/^-|-$/g, "");\n}\n`,
  );
  writeFileSync(
    join(dir, "test", "slug.test.js"),
    `import { test } from "node:test";\nimport assert from "node:assert";\nimport { slugify } from "../slug.js";\n\ntest("words", () => assert.equal(slugify("Hello World"), "hello-world"));\n`,
  );
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return dir;
}

let current: Rig | undefined;
let repo: string | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe.skipIf(targets.length === 0)("real harnesses, lines", () => {
  for (const target of targets) {
    it(`${target.id}: answers quick asks itself and hands long work to a line`, async () => {
      repo = project();
      const turns: Turn[] = [];
      let home = "";
      current = await rig(async () => {}, {
        harness: target.id,
        model: target.model ?? null,
        real: true,
        coalesceMs: 300,
        role: "You are the engineering helper of a small product team. You fix bugs and answer questions in the team group.",
        wrap: recorder(turns, () => home),
      });
      home = current.home;
      const { channel, mingle, agentId } = current;
      const chat = () => mingle.store.agentChats(agentId)[0]?.id as string;
      const tasks = () => mingle.store.tasks(agentId, true);
      const idle = () => !mingle.runtime(agentId)?.busy;
      const out: string[] = [];
      const print = (text: string) => out.push(text);
      const report = () => {
        const t0 = turns[0]?.started ?? 0;
        print(
          turns
            .map(
              (t) =>
                `[${t.session}] +${Math.round((t.started - t0) / 1000)}s ${t.ended ? `${Math.round((t.ended - t.started) / 1000)}s` : "running"}\n${t.actions.map((a) => `    ${a}`).join("\n")}`,
            )
            .join("\n"),
        );
        print(channel.sent.map((m) => `-> ${m.replyTo ? `(re ${m.replyTo}) ` : ""}${m.text}`).join("\n"));
        print(
          tasks()
            .map(
              (t) =>
                `${t.id} ${t.status} ${t.lineState ?? "-"} ${t.title}\n  brief: ${t.brief ?? ""}\n  summary: ${t.summary ?? ""}`,
            )
            .join("\n"),
        );
      };
      try {
        // 1. A quick question: answered in the main session, no line.
        const quick = channel.receive({ text: `@alex_bot what version is the package in ${repo}?` });
        await until(() => channel.sent.find((m) => m.replyTo === quick.platformId), 180_000);
        await until(idle, 120_000);
        expect(tasks().filter((t) => t.lineState)).toHaveLength(0);

        // 2. A code fix: a line, and the main turn ends soon.
        const fix = channel.receive({
          text: `@alex_bot slugify in ${repo} drops digits ("Top 10 Tips" gives "top-tips", should be "top-10-tips"). Please fix it, add a test, run the tests with \`node --test\` and commit.`,
          sender: { id: "u2", name: "Li Si", isBot: false },
        });
        const line = await until(() => tasks().find((t) => t.lineState), 180_000);
        await until(idle, 180_000);
        const mainTurns = turns.filter((t) => t.session === "main");
        const fixTurn = mainTurns[mainTurns.length - 1] as Turn;
        expect(fixTurn.actions.some((a) => /slug\.js/.test(a) && /Edit|Write|apply_patch/i.test(a))).toBe(false);

        // 3. Someone asks about it in a fresh message: passed on to the line.
        channel.receive({ text: "@alex_bot how is the slugify fix going?" });
        await until(() => mingle.store.task(agentId, line.id)?.status === "done", 600_000);
        await until(idle, 180_000);
        await new Promise((r) => setTimeout(r, 3000));
        const log = execFileSync("git", ["log", "--all", "--oneline"], { cwd: repo, encoding: "utf8" });
        report();
        print(log);
        expect(channel.sent.some((m) => m.replyTo === fix.platformId && /10/.test(m.text))).toBe(true);
        expect(
          mingle.store
            .chatMessages(chat(), 30)
            .filter((m) => m.direction === "in")
            .every((m) => m.state === "replied"),
        ).toBe(true);
      } catch (error) {
        report();
        throw error;
      } finally {
        // Kept on disk: vitest may swallow a passing test's output.
        writeFileSync(`e2e-lines-${target.id}.log`, out.join("\n"));
      }
    }, 1_200_000);
  }
});

/**
 * Which asks go to a line: one message each, in a fresh agent, until the main turn ends. The line is
 * not waited for. `MINGLE_E2E_LINES_ROUNDS` repeats each ask (default 1). Writes a table to
 * e2e-lines-<id>-matrix.log.
 */
const asks: { name: string; expect: "line" | "self" | "either"; text: (repo: string) => string }[] = [
  {
    name: "quick fact",
    expect: "self",
    text: () => "@alex_bot what's the difference between git merge and git rebase, in one sentence?",
  },
  { name: "read one file", expect: "self", text: (r) => `@alex_bot which test runner does ${r} use?` },
  {
    name: "small edit",
    expect: "either",
    text: (r) => `@alex_bot please bump the version in ${r}/package.json to 1.2.1 and commit it`,
  },
  {
    name: "bug fix (zh)",
    expect: "line",
    text: (r) =>
      `@alex_bot ${r} 里 slugify 会把数字吃掉，"Top 10 Tips" 变成了 "top-tips"。修一下，补测试，跑 node --test，提交。`,
  },
  {
    name: "investigate",
    expect: "line",
    text: (r) =>
      `@alex_bot can you look into why slugify in ${r} mangles non-English titles like "Café crème" and "東京 2026", and propose a fix?`,
  },
  {
    name: "research",
    expect: "line",
    text: () =>
      "@alex_bot read the READMEs and the open GitHub issues of slugify, @sindresorhus/slugify and limax, and compare how well each handles Chinese and Japanese titles. Which should we use?",
  },
  {
    name: "npm lookup",
    expect: "either",
    text: () =>
      "@alex_bot compare the licenses, weekly downloads and last release dates of slugify, @sindresorhus/slugify and limax on npm, and recommend one",
  },
  {
    name: "long command",
    expect: "line",
    text: (r) => `@alex_bot run \`sleep 200 && node --test\` in ${r} and tell me the result`,
  },
  {
    name: "big codebase",
    expect: "line",
    text: () =>
      `@alex_bot in ${process.cwd()}, how does a message that arrives while the agent is busy get to the harness? Walk me through the code path and tell me if anything can be lost on a restart.`,
  },
  {
    name: "mixed",
    expect: "line",
    text: (r) => `@alex_bot two things: what does ${r} do, and please add a README.md to it describing usage`,
  },
];

const rounds = Number(process.env.MINGLE_E2E_LINES_ROUNDS ?? 1);
describe.skipIf(targets.length === 0)("real harnesses, which asks go to a line", () => {
  for (const target of targets) {
    it(`${target.id}: matrix`, async () => {
      const rows: string[] = [];
      let misses = 0;
      const only = process.env.MINGLE_E2E_LINES_ASKS?.split(",");
      for (const ask of asks.filter((a) => !only || only.includes(a.name))) {
        for (let round = 0; round < rounds; round++) {
          repo = project();
          const turns: Turn[] = [];
          let home = "";
          current = await rig(async () => {}, {
            harness: target.id,
            model: target.model ?? null,
            real: true,
            coalesceMs: 300,
            role: "You are the engineering helper of a small product team. You fix bugs and answer questions in the team group.",
            wrap: recorder(turns, () => home),
          });
          home = current.home;
          const { channel, mingle, agentId } = current;
          const started = Date.now();
          const message = channel.receive({ text: ask.text(repo) });
          let outcome = "timeout";
          try {
            await until(() => turns.some((t) => t.session === "main"), 120_000);
            await until(() => turns.filter((t) => t.session === "main").every((t) => t.ended), 420_000);
            const lined = mingle.store.tasks(agentId, true).some((t) => t.lineState);
            outcome = lined ? "line" : "self";
          } catch {}
          const main = turns.filter((t) => t.session === "main");
          const seconds = Math.round(((main[main.length - 1]?.ended ?? Date.now()) - started) / 1000);
          const actions = main.flatMap((t) => t.actions);
          const acked = channel.sent.find((m) => m.replyTo === message.platformId)?.text ?? "";
          const hit = ask.expect === "either" ? outcome !== "timeout" : outcome === ask.expect;
          if (!hit) misses++;
          rows.push(
            `${hit ? "ok  " : "MISS"} ${ask.name.padEnd(14)} expect=${ask.expect} got=${outcome} main=${seconds}s actions=${actions.length}\n    reply: ${acked.replace(/\s+/g, " ").slice(0, 160)}\n${actions.map((a) => `    ${a.slice(0, 160)}`).join("\n")}`,
          );
          writeFileSync(`e2e-lines-${target.id}-matrix.log`, rows.join("\n"));
          await current.close();
          current = undefined;
          rmSync(repo, { recursive: true, force: true });
          repo = undefined;
        }
      }
      expect(misses).toBe(0);
    }, 7_200_000);
  }
});

/** One main session and three lines on one sign-in at once, and the main session still answers. */
describe.skipIf(targets.length === 0)("real harnesses, three lines at once", () => {
  for (const target of targets) {
    it(`${target.id}: parallel`, async () => {
      const turns: Turn[] = [];
      let home = "";
      const out: string[] = [];
      current = await rig(async () => {}, {
        harness: target.id,
        model: target.model ?? null,
        real: true,
        coalesceMs: 300,
        role: "You are the engineering helper of a small product team. You answer questions in the team group.",
        wrap: recorder(turns, () => home),
      });
      home = current.home;
      const { channel, mingle, agentId } = current;
      const tasks = () => mingle.store.tasks(agentId, true).filter((t) => t.lineState);
      try {
        const asks = ["APPLE", "BANANA", "CHERRY"].map((word, i) =>
          channel.receive({
            text: `@alex_bot please run \`sleep 90\` in a shell and then reply to me with the word ${word}.`,
            sender: { id: `u${i + 1}`, name: `Person ${i + 1}`, isBot: false },
            chat: { platformId: `-10${i}`, kind: "group", name: `Group ${i + 1}` },
          }),
        );
        await until(() => tasks().length === 3, 300_000);
        await until(() => tasks().filter((t) => t.lineState === "running").length === 3, 120_000);
        const asked = Date.now();
        const quick = channel.receive({
          text: "@alex_bot what is 17 times 3?",
          chat: { platformId: "-109", kind: "group", name: "Quick" },
        });
        await until(() => channel.sent.find((m) => m.replyTo === quick.platformId && /51/.test(m.text)), 180_000);
        out.push(`quick answer after ${Math.round((Date.now() - asked) / 1000)}s while 3 lines ran`);
        await until(() => tasks().every((t) => t.status === "done"), 900_000);
        for (const [i, word] of ["APPLE", "BANANA", "CHERRY"].entries()) {
          expect(channel.sent.some((m) => m.replyTo === asks[i]?.platformId && m.text.includes(word))).toBe(true);
        }
      } finally {
        const t0 = turns[0]?.started ?? 0;
        out.push(
          ...turns.map(
            (t) =>
              `[${t.session}] +${Math.round((t.started - t0) / 1000)}s ${t.ended ? `${Math.round((t.ended - t.started) / 1000)}s` : "running"} ${t.actions.length} actions`,
          ),
          ...channel.sent.map(
            (m) => `-> ${m.replyTo ? `(re ${m.replyTo}) ` : ""}${m.text.replace(/\s+/g, " ").slice(0, 120)}`,
          ),
          ...tasks().map((t) => `${t.id} ${t.status} ${t.lineState} ${t.lineError ?? ""} ${t.title}`),
        );
        writeFileSync(`e2e-lines-${target.id}-parallel.log`, out.join("\n"));
      }
    }, 1_500_000);
  }
});
