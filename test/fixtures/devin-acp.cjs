const { createInterface } = require("node:readline");

const sessionId = "devin-fixture";
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const request = (id, method, params) => send({ id, method, params: { sessionId, ...params } });
let promptId;
let terminalId;
const finish = (id, text) => {
  send({
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });
  send({ id, result: { stopReason: "end_turn" } });
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, result, error } = JSON.parse(line);
  if (method === "initialize") send({ id, result: { protocolVersion: 1 } });
  else if (method === "session/new") send({ id, result: { sessionId } });
  else if (method === "session/prompt") {
    promptId = id;
    const command = process.platform === "win32" ? "echo %MINGLE_TEST%" : `printf '%s' "$MINGLE_TEST"`;
    request(101, "terminal/create", { command });
  } else if (id === 101) {
    if (error) {
      finish(promptId, error.message);
      return;
    }
    terminalId = result.terminalId;
    request(102, "terminal/wait_for_exit", { terminalId });
  } else if (id === 102) {
    request(103, "terminal/output", { terminalId });
  } else if (id === 103) {
    finish(promptId, result?.output || error?.message || "no terminal output");
  }
});
