import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installRemoteNode } from "../platform/remote-install.ts";
import { remoteHome, remoteNodeCommand, spawnSsh, sshFailure, sshTarget } from "../platform/ssh.ts";
import { type RemoteRequest, type RemoteResponse, RpcClient } from "../remote/wire.ts";
import { MingleError } from "./errors.ts";
import { REMOTE_ID, type RemoteHost, type RemoteInstallJob, remoteAgent, remoteId } from "./remote.ts";

export interface RemoteControl {
  request(request: RemoteRequest, timeoutMs?: number): Promise<RemoteResponse>;
  close(): void;
}
export interface RemoteTransport {
  install(host: string, signal: AbortSignal): Promise<void>;
  prepare(host: string, home: string): Promise<{ home: string; runtime: string }>;
  connect(host: RemoteHost): RemoteControl;
}

export const sshTransport: RemoteTransport = {
  install: installRemoteNode,
  async prepare(host, home) {
    const source = new URL("../remote/bootstrap.mjs", import.meta.url);
    const archive = new URL("../../dist/ssh-runtime.tgz", import.meta.url);
    if (!existsSync(archive))
      throw new MingleError("ssh_runtime_missing", "Build Mingle before preparing a remote host.");
    const bytes = readFileSync(archive);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const child = spawnSsh(
      host,
      remoteNodeCommand(["--input-type=module", "-e", readFileSync(source, "utf8"), home, hash]),
    );
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new MingleError(
            "ssh_setup_timeout",
            "Remote setup timed out. Check Node.js, npm and network access on the host.",
          ),
        );
      }, 300_000);
      child.stdout.on("data", (data: Buffer) => {
        stdout = (stdout + data.toString()).slice(-16_384);
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-8192);
      });
      child.stdin.on("error", () => {});
      child.on("error", () => {
        clearTimeout(timer);
        reject(sshFailure(stderr));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(sshFailure(stderr));
          return;
        }
        try {
          const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as { home: string; runtime: string };
          if (!result.home.startsWith("/") || !result.runtime.startsWith("/")) throw new Error("invalid setup result");
          resolve(result);
        } catch {
          reject(sshFailure(stderr));
        }
      });
      child.stdin.end(bytes);
    });
  },
  connect(host) {
    const child = spawnSsh(host.host, remoteNodeCommand([`${host.runtime}/dist/remote/control.js`, host.home]));
    const rpc = new RpcClient(child.stdout, child.stdin);
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-8192);
    });
    child.on("error", () => rpc.close(sshFailure(stderr)));
    child.on("close", () => rpc.close(sshFailure(stderr)));
    return {
      request: (request, timeoutMs) => rpc.request(request, timeoutMs),
      close: () => {
        rpc.close();
        child.kill();
      },
    };
  },
};

interface Registry {
  hosts: RemoteHost[];
  agents: Record<string, Record<string, unknown>[]>;
}

/** Local management records. Remote agents and their connections belong to the remote daemon. */
export class Remotes {
  private readonly file: string;
  private readonly registry: Registry;
  private readonly controls = new Map<string, RemoteControl>();
  private readonly adding = new Map<string, Promise<RemoteHost>>();
  private readonly installations = new Map<string, { view: RemoteInstallJob; abort: AbortController }>();
  private readonly polling = new Map<string, Promise<Record<string, unknown>[]>>();
  private readonly reachable = new Map<string, boolean>();
  private readonly revisions = new Map<string, number>();
  private closed = false;
  private readonly transport: RemoteTransport;
  constructor(home: string, transport: RemoteTransport = sshTransport) {
    this.transport = transport;
    mkdirSync(home, { recursive: true });
    this.file = join(home, "ssh-hosts.json");
    this.registry = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, "utf8")) as Registry)
      : { hosts: [], agents: {} };
  }
  list(): (RemoteHost & { reachable: boolean | null })[] {
    return this.registry.hosts.map((host) => ({ ...host, reachable: this.reachable.get(host.id) ?? null }));
  }
  host(id: string): RemoteHost {
    const host = this.registry.hosts.find((item) => item.id === id);
    if (!host || !REMOTE_ID.test(id)) throw new MingleError("ssh_host_missing", "Choose a configured SSH host.", 404);
    return host;
  }
  private save(): void {
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.registry), { mode: 0o600 });
    renameSync(temp, this.file);
  }
  installation(id: string): RemoteInstallJob {
    const job = this.installations.get(id);
    if (!job) throw new MingleError("ssh_install_missing", "Start the remote installation again.", 404);
    return job.view;
  }
  install(input: { host: unknown; home: unknown }): RemoteInstallJob {
    const host = sshTarget(input.host);
    const home = remoteHome(input.home);
    if (this.closed) throw new MingleError("ssh_unavailable", "Mingle is stopping.", 503);
    for (const { view } of this.installations.values()) {
      if (view.host !== host || view.state !== "running") continue;
      if (view.home === home) return view;
      throw new MingleError("ssh_install_busy", "An installation is already running on this host.", 409);
    }
    const job = {
      view: {
        id: `si_${randomBytes(6).toString("hex")}`,
        host,
        home,
        state: "running",
        phase: "installing",
      } as RemoteInstallJob,
      abort: new AbortController(),
    };
    this.installations.set(job.view.id, job);
    void (async () => {
      try {
        await this.transport.install(host, job.abort.signal);
        if (this.closed) return;
        job.view = { ...job.view, phase: "preparing" };
        const result = await this.add({ host, home });
        if (!this.closed) job.view = { ...job.view, state: "done", result };
      } catch (error) {
        if (!this.closed)
          job.view = {
            ...job.view,
            state: "failed",
            error: error instanceof MingleError ? error.code : "ssh_install_failed",
          };
      } finally {
        setTimeout(() => this.installations.delete(job.view.id), 30 * 60_000).unref();
      }
    })();
    return job.view;
  }
  add(input: { host: unknown; home: unknown }): Promise<RemoteHost> {
    const target = sshTarget(input.host);
    const home = remoteHome(input.home);
    const key = `${target}\n${home}`;
    const pending = this.adding.get(key);
    if (pending) return pending;
    const work = this.prepare(target, home).finally(() => this.adding.delete(key));
    this.adding.set(key, work);
    return work;
  }
  private async prepare(target: string, home: string): Promise<RemoteHost> {
    if (this.closed) throw new MingleError("ssh_unavailable", "Mingle is stopping.", 503);
    const ready = await this.transport.prepare(target, home);
    if (this.closed)
      throw new MingleError("ssh_unavailable", "Mingle is stopping. The prepared remote service remains running.", 503);
    const existing = this.registry.hosts.find((item) => item.host === target && item.home === ready.home);
    const host: RemoteHost = { id: existing?.id ?? `ssh_${randomBytes(6).toString("hex")}`, host: target, ...ready };
    this.revisions.set(host.id, (this.revisions.get(host.id) ?? 0) + 1);
    this.controls.get(host.id)?.close();
    this.controls.delete(host.id);
    if (existing) Object.assign(existing, host);
    else this.registry.hosts.push(host);
    this.save();
    return host;
  }
  async request(id: string, request: RemoteRequest, timeoutMs = 30_000): Promise<RemoteResponse> {
    const host = this.host(id);
    if (this.closed) throw new MingleError("ssh_unavailable", "Mingle is stopping.", 503);
    let control = this.controls.get(id);
    if (!control) {
      control = this.transport.connect(host);
      this.controls.set(id, control);
    }
    try {
      const response = await control.request(request, timeoutMs);
      if (this.closed || this.controls.get(id) !== control) throw new Error("superseded SSH control connection");
      this.reachable.set(id, true);
      const decorated = this.decorate(host, request, response);
      if (request.method !== "GET" && response.status < 400) {
        this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
        const agent = decorated.body as Record<string, unknown> | null;
        const cached = this.registry.agents[id] ?? [];
        if (agent?.remote && agent.id && agent.slug) {
          this.registry.agents[id] = [...cached.filter((item) => item.id !== agent.id), agent];
          this.save();
        } else if (request.method === "DELETE" && /^\/v1\/admin\/agents\/[^/?]+$/.test(request.path)) {
          this.registry.agents[id] = cached.filter(
            (item) => item.id !== remoteId(id, decodeURIComponent(request.path.split("/").at(-1) ?? "")),
          );
          this.save();
        }
      }
      return decorated;
    } catch (error) {
      if (this.controls.get(id) === control) {
        this.reachable.set(id, false);
        this.controls.delete(id);
        control.close();
      }
      if (error instanceof MingleError) throw error;
      throw sshFailure("");
    }
  }
  private decorate(host: RemoteHost, request: RemoteRequest, response: RemoteResponse): RemoteResponse {
    if (response.status >= 400) return response;
    const path = request.path.split("?")[0] ?? "";
    const body = response.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return response;
    if (Array.isArray(body) && (path === "/v1/admin/brains" || path === "/v1/admin/harnesses")) {
      return {
        ...response,
        body: body.map((item: Record<string, unknown>) => ({
          ...item,
          id: remoteId(host.id, String(item.id)),
          ...Object.fromEntries(
            ["installJob", "upgradeJob"]
              .filter((key) => item[key])
              .map((key) => [
                key,
                {
                  ...(item[key] as Record<string, unknown>),
                  id: remoteId(host.id, String((item[key] as Record<string, unknown>).id)),
                },
              ]),
          ),
        })),
      };
    }
    if (Array.isArray(body) && /\/agents\/[^/]+\/(contacts|access)$/.test(path)) {
      const connection = (item: Record<string, unknown>) => ({
        ...item,
        connection: remoteId(host.id, String(item.connection)),
      });
      return {
        ...response,
        body: body.map((item: Record<string, unknown>) =>
          Array.isArray(item.accounts) ? { ...item, accounts: item.accounts.map(connection) } : connection(item),
        ),
      };
    }
    if (path === "/v1/admin/status")
      return {
        ...response,
        body: { ...body, agents: (body.agents as Record<string, unknown>[]).map((agent) => remoteAgent(host, agent)) },
      };
    if (path === "/v1/admin/agents" || path.startsWith("/v1/admin/agents/")) {
      if (body.id && body.slug) return { ...response, body: remoteAgent(host, body) };
    }
    if (
      body.id &&
      (/\/onboarding(?:\/[^/]+)?$/.test(path) ||
        /\/connections$/.test(path) ||
        /\/jobs\//.test(path) ||
        /\/brains\/[^/]+\/(install|upgrade|sign-in)$/.test(path))
    ) {
      return { ...response, body: { ...body, id: remoteId(host.id, String(body.id)) } };
    }
    return response;
  }
  async agents(): Promise<Record<string, unknown>[]> {
    const groups = await Promise.all(
      this.registry.hosts.map((host) => {
        const old = this.polling.get(host.id);
        if (old) return old;
        const work = this.poll(host).finally(() => this.polling.delete(host.id));
        this.polling.set(host.id, work);
        return work;
      }),
    );
    return groups.flat();
  }
  private async poll(host: RemoteHost): Promise<Record<string, unknown>[]> {
    const revision = this.revisions.get(host.id);
    try {
      const result = await this.request(host.id, { method: "GET", path: "/v1/admin/status" }, 4000);
      // A read started before a mutation must not hide a newly created agent or resurrect a deleted one.
      if (revision !== this.revisions.get(host.id)) return this.poll(host);
      if (result.status !== 200) throw new Error("remote status unavailable");
      const agents = (result.body as { agents: Record<string, unknown>[] }).agents;
      if (JSON.stringify(agents) !== JSON.stringify(this.registry.agents[host.id])) {
        this.registry.agents[host.id] = agents;
        this.save();
      }
      return agents;
    } catch {
      return (this.registry.agents[host.id] ?? []).map((agent) => ({
        ...agent,
        remote: { id: host.id, host: host.host, reachable: false },
      }));
    }
  }
  close(): void {
    this.closed = true;
    for (const job of this.installations.values()) {
      if (job.view.state !== "running") continue;
      job.view = { ...job.view, state: "failed", error: "ssh_unavailable" };
      job.abort.abort();
    }
    for (const control of this.controls.values()) control.close();
    this.controls.clear();
  }
}
