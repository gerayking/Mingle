// A separate, real Mingle process with a scripted harness and a fake chat platform.
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { messageIds, rig, runCli } from "../helpers.ts";

const home = process.env.MINGLE_HOME as string;
const remote = await rig(async (turn) => {
  for (const id of messageIds(turn.input)) {
    const sent = await runCli(turn.options.env as Record<string, string>, ["message", "reply", id], "still here");
    if (sent.code !== 0) throw new Error(sent.stderr);
  }
});
writeFileSync(
  join(home, "runtime.json"),
  JSON.stringify({ url: remote.url, adminToken: remote.mingle.adminToken, pid: process.pid }),
  { mode: 0o600 },
);
const platform = createServer((request, response) => {
  if (request.url === "/receive") remote.channel.receive({ text: "Are you still online?" });
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ sent: remote.channel.sent, pid: process.pid }));
});
await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
const address = platform.address() as { port: number };
writeFileSync(
  join(home, "fixture.json"),
  JSON.stringify({ url: `http://127.0.0.1:${address.port}`, pid: process.pid }),
);
const stop = async () => {
  await remote.close();
  platform.close();
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
