import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MingleError } from "../src/core/errors.ts";
import type { RemoteHost, RemoteInstallJob } from "../src/core/remote.ts";
import { Remotes, type RemoteTransport } from "../src/core/remotes.ts";
import { rig, until } from "./helpers.ts";

function fixture() {
  const installed = Promise.withResolvers<void>();
  const prepared = Promise.withResolvers<{ home: string; runtime: string }>();
  const install = vi.fn((_host: string, _signal: AbortSignal) => installed.promise);
  const prepare = vi.fn(() => prepared.promise);
  const transport: RemoteTransport = {
    install,
    prepare,
    connect: () => {
      throw new Error("No real connections in setup tests");
    },
  };
  return { installed, prepared, install, prepare, transport };
}

describe("remote install and connect", () => {
  it("requires admin auth, validates the host and reuses a job through installation and preparation", async () => {
    const f = fixture();
    const local = await rig(async () => {}, { remoteTransport: f.transport });
    const input = { host: "fixture", home: "~/data" };
    try {
      const unauthorized = await fetch(`${local.url}/v1/admin/ssh/installations`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      expect(unauthorized.status).toBe(401);
      expect(
        (await local.admin("POST", "/v1/admin/ssh/installations", { ...input, host: "-oProxyCommand=evil" })).status,
      ).toBe(400);
      expect((await local.admin("POST", "/v1/admin/ssh/installations", { ...input, home: "relative" })).status).toBe(
        400,
      );
      expect(f.install).not.toHaveBeenCalled();
      const started = await local.admin("POST", "/v1/admin/ssh/installations", input);
      expect(started.status).toBe(202);
      const job = started.json as RemoteInstallJob;
      expect(job).toMatchObject({ state: "running", phase: "installing", ...input });
      const path = `/v1/admin/ssh/installations/${job.id}`;
      expect((await fetch(`${local.url}${path}`)).status).toBe(401);
      expect((await local.admin("POST", "/v1/admin/ssh/installations", input)).json).toMatchObject({ id: job.id });
      expect((await local.admin("POST", "/v1/admin/ssh/installations", { ...input, home: "~/other" })).status).toBe(
        409,
      );
      expect(f.install).toHaveBeenCalledTimes(1);
      expect(f.install.mock.calls[0]?.[0]).toBe("fixture");
      expect(f.prepare).not.toHaveBeenCalled();
      f.installed.resolve();
      await until(() => f.prepare.mock.calls.length === 1);
      expect((await local.admin("GET", path)).json).toMatchObject({ state: "running", phase: "preparing" });
      expect((await local.admin("POST", "/v1/admin/ssh/installations", input)).json).toMatchObject({ id: job.id });
      f.prepared.resolve({ home: "/fixture/data", runtime: "/fixture/runtime" });
      await until(() => local.mingle.remotes.installation(job.id).state === "done");
      const done = (await local.admin("GET", path)).json as RemoteInstallJob;
      expect(done.result).toMatchObject({ host: "fixture", home: "/fixture/data" });
      expect(local.mingle.remotes.list()).toEqual([expect.objectContaining(done.result as RemoteHost)]);
      expect((await local.admin("GET", "/v1/admin/ssh/installations/missing")).status).toBe(404);
    } finally {
      await local.close();
    }
  });

  it("does not prepare after a failed installation and lets a retry recover", async () => {
    const home = mkdtempSync(join(tmpdir(), "mingle-setup-"));
    const f = fixture();
    f.install.mockRejectedValueOnce(new MingleError("ssh_install_download", "private-secret"));
    const manager = new Remotes(home, f.transport);
    try {
      const first = manager.install({ host: "fixture", home: "~/data" });
      await until(() => manager.installation(first.id).state === "failed");
      expect(manager.installation(first.id)).toMatchObject({ error: "ssh_install_download" });
      expect(JSON.stringify(manager.installation(first.id))).not.toContain("private-secret");
      expect(f.prepare).not.toHaveBeenCalled();
      expect(manager.list()).toEqual([]);
      const retry = manager.install({ host: "fixture", home: "~/data" });
      expect(retry.id).not.toBe(first.id);
      f.installed.resolve();
      f.prepared.reject(new MingleError("ssh_setup_timeout", "private-secret"));
      await until(() => manager.installation(retry.id).state === "failed");
      expect(manager.installation(retry.id)).toMatchObject({ phase: "preparing", error: "ssh_setup_timeout" });
      expect(manager.list()).toEqual([]);
    } finally {
      manager.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("aborts setup when Mingle stops and ignores late installation results", async () => {
    const home = mkdtempSync(join(tmpdir(), "mingle-setup-"));
    const f = fixture();
    const manager = new Remotes(home, f.transport);
    try {
      const job = manager.install({ host: "fixture", home: "~/data" });
      manager.close();
      expect(f.install.mock.calls[0]?.[1].aborted).toBe(true);
      f.installed.resolve();
      await Promise.resolve();
      expect(manager.installation(job.id)).toMatchObject({ state: "failed", error: "ssh_unavailable" });
      expect(f.prepare).not.toHaveBeenCalled();
      expect(manager.list()).toEqual([]);
      expect(() => manager.install({ host: "fixture", home: "~/data" })).toThrow("stopping");
    } finally {
      manager.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
