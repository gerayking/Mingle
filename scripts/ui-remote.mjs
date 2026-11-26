// Browser fixtures for Remote SSH. Every SSH operation is intercepted; no host is contacted.
export const REMOTE_MOCK = `(() => {
  const real = window.fetch.bind(window);
  const host = { id: "ssh_0123456789ab", host: "developer@remote-development-machine.example", home: "/home/developer/.mingle-remote", reachable: true };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const agent = (base, mode) => ({ ...base, id: host.id + "~a-review", slug: host.id + "~remote-review", name: "Remote companion", harness: host.id + "~scripted", harnessName: "Remote test brain", avatar: null, status: "idle", statusDetail: null, statusFailure: null, hasReplied: true, home: host.home + "/agents/remote-review", connections: [], requests: [], remote: { ...host, reachable: mode !== "offline" } });
  window.fetch = async (input, init) => {
    const mode = sessionStorage.getItem("mingle.ssh-review");
    if (!mode) return real(input, init);
    const path = typeof input === "string" ? input : input.url;
    const method = init?.method || "GET";
    if (path === "/v1/admin/ssh/config") {
      const configMode = sessionStorage.getItem("mingle.ssh-config");
      if (configMode === "failed") return json({ error: "internal" }, 500);
      return json({ hosts: configMode === "empty" ? [] : ["review-fixture", "development-with-a-long-ssh-config-alias"], incomplete: configMode === "partial" });
    }
    if (path === "/v1/admin/status") {
      const result = await (await real(input, init)).json();
      sessionStorage.setItem("mingle.ssh-base", JSON.stringify(result.agents[0]));
      return json({ ...result, agents: [...result.agents, agent(result.agents[0], mode)] });
    }
    if (path === "/v1/admin/ssh/hosts") {
      if (method === "GET") return json([host]);
      const body = JSON.parse(init.body);
      sessionStorage.setItem("mingle.ssh-prepared", init.body);
      if (body.host === "bad-host") return json({ error: "ssh_auth", next: "SSH failed" }, 400);
      if (body.host === "missing-node") return json({ error: "ssh_node_missing" }, 400);
      return json(host, 201);
    }
    if (path === "/v1/admin/ssh/installations" && method === "POST") {
      const body = JSON.parse(init.body);
      sessionStorage.setItem("mingle.ssh-installed", init.body);
      sessionStorage.setItem("mingle.ssh-install-phase", "installing");
      return json({ id: "si_fixture", ...body, state: "running", phase: "installing" }, 202);
    }
    if (path === "/v1/admin/ssh/installations/si_fixture") {
      const phase = sessionStorage.getItem("mingle.ssh-install-phase");
      if (phase === "poll-failed") return json({ error: "internal" }, 503);
      if (phase === "missing") return json({ error: "ssh_install_missing" }, 404);
      const body = JSON.parse(sessionStorage.getItem("mingle.ssh-installed"));
      return json({ id: "si_fixture", ...body, phase: phase === "preparing" ? "preparing" : "installing",
        state: phase === "done" ? "done" : phase === "failed" ? "failed" : "running",
        ...(phase === "done" ? { result: host } : phase === "failed" ? { error: "ssh_install_download" } : {}) });
    }
    if (path.startsWith("/v1/admin/ssh/" + host.id + "/brains")) return json([{ id: host.id + "~scripted", name: "Remote test brain", installed: true }]);
    if (path === "/v1/admin/agents" && method === "POST") {
      const body = JSON.parse(init.body);
      if (body.harness.startsWith(host.id + "~")) {
        sessionStorage.setItem("mingle.ssh-created", init.body);
        return json(agent(JSON.parse(sessionStorage.getItem("mingle.ssh-base")), mode), 201);
      }
    }
    if (path.includes(host.id)) {
      if (mode === "offline") return json({ error: "ssh_unavailable" }, 503);
      if (path.includes("/sign-in")) return json({ kind: "unknown" });
      if (path.includes("/models")) return json({ kind: "unsupported" });
      if (path.endsWith("/work")) return json({ tasks: [], reminders: [] });
      return json([]);
    }
    return real(input, init);
  };
})()`;
