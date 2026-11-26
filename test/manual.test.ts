import { describe, expect, it } from "vitest";
import { renderManual } from "../src/core/manual.ts";

describe("manual", () => {
  it("adds PowerShell instructions only on Windows", () => {
    expect(renderManual("Alex", "", "darwin")).not.toContain("PowerShell");
    const windows = renderManual("Alex", "", "win32");
    expect(windows).toContain("& $env:MINGLE_CLI message reply");
    expect(windows).toContain("Alex");
  });

  it("tells the agent never to message people through other accounts on this computer", () => {
    // MING-100: agents wrote to colleagues through a signed-in Feishu CLI, under someone else's name.
    const manual = renderManual("Alex", "", "darwin");
    expect(manual).toContain("`mingle` is the only way you talk to people.");
    expect(manual).toMatch(/CLIs, MCP servers or skills[^\n]*Never use them to send/);
  });
});
