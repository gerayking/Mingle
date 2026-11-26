import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/store.ts";
import { type Rig, rig } from "./helpers.ts";

let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

describe("agent sidebar order", () => {
  it("persists local and remote IDs, appends unlisted agents, and cleans up deleted ones", () => {
    let tick = 1000;
    const store = new Store(":memory:", () => ++tick);
    try {
      const a1 = store.createAgent({ name: "Alex", slug: "alex", harness: "scripted" });
      const a2 = store.createAgent({ name: "Bea", slug: "bea", harness: "scripted" });
      const a3 = store.createAgent({ name: "Cy", slug: "cy", harness: "scripted" });
      const remote = { id: "ssh_0123456789ab~a_rem01" };

      // Default order is creation order.
      expect(store.agentOrder()).toEqual([]);
      expect(store.orderByAgentOrder([a1, a2, a3, remote]).map((x) => x.id)).toEqual([a1.id, a2.id, a3.id, remote.id]);

      // Saving deduplicates and trims IDs, and interleaves local + remote agents.
      expect(store.setAgentOrder([remote.id, a3.id, ` ${a1.id} `, a3.id, ""])).toEqual([remote.id, a3.id, a1.id]);
      expect(store.orderByAgentOrder([a1, a2, a3, remote]).map((x) => x.id)).toEqual([remote.id, a3.id, a1.id, a2.id]);

      // A newly created agent stays at the end so existing positions do not shift.
      const a4 = store.createAgent({ name: "Dan", slug: "dan", harness: "scripted" });
      expect(store.orderByAgentOrder([a1, a2, a3, a4, remote]).map((x) => x.id)).toEqual([
        remote.id,
        a3.id,
        a1.id,
        a2.id,
        a4.id,
      ]);

      // Deleting an agent removes its order entry.
      store.deleteAgent(a3.id);
      expect(store.agentOrder()).toEqual([remote.id, a1.id]);
    } finally {
      store.close();
    }
  });

  it("serves saved order from both /status and /summary and rejects invalid payloads", async () => {
    current = await rig(async () => {});
    const r = current;

    const bea = r.mingle.createAgent({ name: "Bea", role: "", harness: "scripted" });
    const cy = r.mingle.createAgent({ name: "Cy", role: "", harness: "scripted" });

    const beforeStatus = (await r.admin("GET", "/v1/admin/status")).json as { agents: { id: string }[] };
    expect(beforeStatus.agents.map((a) => a.id)).toEqual([r.agentId, bea.id, cy.id]);

    // Invalid payloads are rejected without changing the saved order.
    expect(await r.admin("PUT", "/v1/admin/agents/order", { ids: "not-an-array" })).toMatchObject({
      status: 400,
      json: { error: "invalid_order" },
    });
    expect(await r.admin("PUT", "/v1/admin/agents/order", { ids: [cy.id, ""] })).toMatchObject({
      status: 400,
      json: { error: "invalid_order" },
    });

    const saved = await r.admin("PUT", "/v1/admin/agents/order", { ids: [cy.id, r.agentId, bea.id] });
    expect(saved).toMatchObject({ status: 200, json: { ids: [cy.id, r.agentId, bea.id] } });

    const status = (await r.admin("GET", "/v1/admin/status")).json as { agents: { id: string }[] };
    expect(status.agents.map((a) => a.id)).toEqual([cy.id, r.agentId, bea.id]);

    // Desktop menu bar summary follows the exact same order.
    const summary = (await r.admin("GET", "/v1/admin/summary")).json as { agents: { id: string }[] };
    expect(summary.agents.map((a) => a.id)).toEqual([cy.id, r.agentId, bea.id]);

    // A newly created agent appends at the end.
    const dan = r.mingle.createAgent({ name: "Dan", role: "", harness: "scripted" });
    const afterCreate = (await r.admin("GET", "/v1/admin/status")).json as { agents: { id: string }[] };
    expect(afterCreate.agents.map((a) => a.id)).toEqual([cy.id, r.agentId, bea.id, dan.id]);
  });
});
