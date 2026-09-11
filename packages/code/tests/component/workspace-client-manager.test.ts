import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";
import { ownerFromWorkspace } from "@clarvis/paths";
import { withoutGitRepositoryEnvironment } from "@clarvis/kernel/local";
import { connectOrLaunchLocalKernel } from "@clarvis/kernel/bootstrap";
import type { KernelClient } from "@clarvis/protocol";

import { WorkspaceClientManager } from "../../src/adapters/workspace-client-manager.ts";
import { prepareStartupFoundation } from "../../src/startup-foundation.ts";
import { openTempDir } from "../helpers/tracked-temp.ts";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: withoutGitRepositoryEnvironment(process.env),
    stdio: "ignore",
  });
}

describe("WorkspaceClientManager", () => {
  it("explicit idle reload replaces the host generation", async () => {
    const root = openTempDir("clarvis-workspace-idle-reload-");
    const workspaceRoot = join(root, "workspace");
    mkdirSync(workspaceRoot);
    const manager = await WorkspaceClientManager.create({
      workspaceRoot,
      globalDir: join(root, "global"),
    });
    try {
      const original = (await manager.open()).client;
      const generation = (await original.localHost!.inspect()).host_generation;
      await manager.invalidate(manager.current.id);
      const replacement = (await manager.open()).client;
      expect((await replacement.localHost!.inspect()).host_generation).not.toBe(generation);
      await expect(original.localHost!.inspect()).rejects.toThrow();
      await replacement.localHost!.requestRestart();
    } finally {
      await manager.close();
    }
  });

  it("a candidate that fails inspection cannot replace a healthy connection", async () => {
    const root = openTempDir("clarvis-workspace-recovery-candidate-");
    const workspaceRoot = join(root, "workspace");
    mkdirSync(workspaceRoot);
    let connects = 0;
    let candidateClosed = false;
    const manager = await WorkspaceClientManager.create(
      { workspaceRoot, globalDir: join(root, "global") },
      {
        connectHost: async (options) => {
          const result = await connectOrLaunchLocalKernel(options);
          if (++connects === 1) return result;
          return {
            client: {
              ...result.client,
              localHost: {
                ...result.client.localHost!,
                inspect: async () => {
                  throw new Error("candidate handshake lost");
                },
              },
              close: async () => {
                await result.client.close();
                candidateClosed = true;
              },
            },
          };
        },
      },
    );
    try {
      const original = (await manager.open()).client;
      const generation = (await original.localHost!.inspect()).host_generation;
      await expect(manager.recover(manager.current.id)).rejects.toThrow("candidate handshake lost");
      const retained = (await manager.open()).client;
      expect(retained.localHost).toBe(original.localHost);
      expect((await retained.localHost!.inspect()).host_generation).toBe(generation);
      expect(candidateClosed).toBe(true);
      await original.localHost!.requestRestart();
    } finally {
      await manager.close();
    }
  });

  it("recovers a broken socket without restarting the host or replaying execution", async () => {
    const root = openTempDir("clarvis-workspace-reconnect-");
    const workspaceRoot = join(root, "workspace");
    mkdirSync(workspaceRoot);
    let connected: KernelClient | undefined;
    let restartRequests = 0;
    const manager = await WorkspaceClientManager.create(
      { workspaceRoot, globalDir: join(root, "global") },
      {
        connectHost: async (options) => {
          const result = await connectOrLaunchLocalKernel(options);
          connected = result.client;
          const controls = result.client.localHost!;
          return {
            client: {
              ...result.client,
              localHost: {
                ...controls,
                requestRestart: async () => {
                  restartRequests++;
                  await controls.requestRestart();
                },
              },
            },
          };
        },
      },
    );
    try {
      const original = connected!;
      const generation = (await original.localHost!.inspect()).host_generation;
      await original.close();
      await expect(original.localHost!.inspect()).rejects.toThrow();
      await manager.recover(manager.current.id);
      const reopened = await manager.open();
      expect((await reopened.client.localHost!.inspect()).host_generation).toBe(generation);
      expect(restartRequests).toBe(0);
      expect(await reopened.client.hosting!.list()).toEqual([]);
      await connected!.localHost!.requestRestart();
    } finally {
      await manager.close();
    }
  });

  it("a refused reload preserves its original connection while physical activity is reserved", async () => {
    const root = openTempDir("clarvis-workspace-reload-");
    const workspaceRoot = join(root, "workspace");
    mkdirSync(workspaceRoot);
    const manager = await WorkspaceClientManager.create({
      workspaceRoot,
      globalDir: join(root, "global"),
    });
    let leaseId: string | undefined;
    const original = (await manager.open()).client;
    try {
      const before = await original.localHost!.inspect();
      const lease = await original.hosting!.reserveActivity("test-session", "shell");
      leaseId = lease.lease_id;
      await expect(manager.invalidate(manager.current.id)).rejects.toThrow();
      const retained = (await manager.open()).client;
      expect(retained.localHost).toBe(original.localHost);
      expect((await retained.localHost!.inspect()).host_generation).toBe(before.host_generation);
      await original.hosting!.releaseActivity(leaseId);
      leaseId = undefined;
      await original.localHost!.requestRestart();
    } finally {
      if (leaseId !== undefined) await original.hosting!.releaseActivity(leaseId);
      await manager.close();
    }
  });

  it("prepares the startup foundation from process-pinned paths and owner", async () => {
    const root = openTempDir("clarvis-startup-foundation-");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const previousHome = process.env.CLARVIS_HOME;
    const previousWorkspace = process.env.CLARVIS_WORKSPACE_ROOT;
    const previousOwner = process.env.CLARVIS_OWNER;
    let manager: WorkspaceClientManager | undefined;
    try {
      process.env.CLARVIS_HOME = join(root, "global");
      process.env.CLARVIS_WORKSPACE_ROOT = workspace;
      process.env.CLARVIS_OWNER = "startup-owner";
      manager = await prepareStartupFoundation({
        kind: "run",
        ascii: false,
        debug: { enabled: false },
        extensionProfileSelector: "builtin:default",
      });
      expect(manager.current.path).toBe(realpathSync(workspace));
      expect(manager.defaultOwner).toBe("startup-owner");
      await manager.close();
      manager = undefined;

      delete process.env.CLARVIS_OWNER;
      manager = await prepareStartupFoundation({
        kind: "run",
        ascii: false,
        debug: { enabled: false },
      });
      expect(manager.defaultOwner).toBe(ownerFromWorkspace(workspace));
    } finally {
      await manager?.close();
      if (previousHome === undefined) delete process.env.CLARVIS_HOME;
      else process.env.CLARVIS_HOME = previousHome;
      if (previousWorkspace === undefined) delete process.env.CLARVIS_WORKSPACE_ROOT;
      else process.env.CLARVIS_WORKSPACE_ROOT = previousWorkspace;
      if (previousOwner === undefined) delete process.env.CLARVIS_OWNER;
      else process.env.CLARVIS_OWNER = previousOwner;
    }
  });

  it("opens only the process-pinned workspace", async () => {
    const root = openTempDir("clarvis-workspaces-");
    const workspaceRoot = join(root, "workspace");
    mkdirSync(workspaceRoot);
    const globalDir = join(root, "global");
    git(workspaceRoot, "init", "--quiet");
    git(workspaceRoot, "config", "user.email", "tests@example.com");
    git(workspaceRoot, "config", "user.name", "Clarvis Tests");
    git(workspaceRoot, "commit", "--allow-empty", "-m", "initial", "--quiet");

    const manager = await WorkspaceClientManager.create({
      workspaceRoot,
      globalDir,
    });
    expect(manager.project.id).toStartWith("prj_");

    const opened = await manager.open();
    expect(opened.workspace).toEqual(manager.current);
    await opened.release();
    await opened.release();
    await expect(manager.open("another-workspace")).rejects.toThrow("pinned to one workspace");

    await manager.close();
    await manager.close();
  });

  it("derives the default owner from the selected linked checkout", async () => {
    const workspaceRoot = openTempDir("clarvis-primary-owner-");
    const externalRoot = join(workspaceRoot, "linked");
    const primaryRoot = join(workspaceRoot, "primary");
    git(workspaceRoot, "init", "--quiet", primaryRoot);
    git(primaryRoot, "config", "user.email", "tests@example.com");
    git(primaryRoot, "config", "user.name", "Clarvis Tests");
    git(primaryRoot, "commit", "--allow-empty", "-m", "initial", "--quiet");
    git(primaryRoot, "worktree", "add", "--quiet", "-b", "linked", externalRoot, "HEAD");

    const manager = await WorkspaceClientManager.create({
      workspaceRoot: externalRoot,
      globalDir: join(workspaceRoot, "global"),
    });
    expect(manager.current.path).toBe(realpathSync(externalRoot));
    expect(manager.defaultOwner).toBe(ownerFromWorkspace(externalRoot));
    expect(manager.defaultOwner).not.toBe(ownerFromWorkspace(primaryRoot));
    await manager.close();
  });

  it("uses the remote host namespace, reconnects SSH and never requests local controls", async () => {
    const root = openTempDir("clarvis-workspace-remote-");
    const workspaceRoot = join(root, "workspace");
    mkdirSync(workspaceRoot);
    const backing = await WorkspaceClientManager.create({
      workspaceRoot,
      globalDir: join(root, "global"),
    });
    const backingClient = (await backing.open()).client;
    const closures: Array<ReturnType<typeof Promise.withResolvers<string>>> = [];
    const launches: unknown[] = [];
    const lifecycle: string[] = [];
    let connects = 0;
    let active = 0;
    const manager = await WorkspaceClientManager.create(
      {
        workspaceRoot: "/srv/remote/project",
        globalDir: join(root, "unused-client-global"),
        remote: { destination: "operator@example.test", workspace: "/srv/remote/project" },
      },
      {
        resolveArtifact: async () => {
          throw new Error("remote connection must not resolve a local host artifact");
        },
        connectRemoteHost: async (options) => {
          lifecycle.push(`connect-${connects + 1}`);
          if (active !== 0) throw new Error("another kernel host owns this workspace");
          launches.push(options);
          connects++;
          active++;
          const closed = Promise.withResolvers<string>();
          closures.push(closed);
          let clientClosed = false;
          return {
            client: {
              ...backingClient,
              workspace: { ...backingClient.workspace, path: "/srv/remote/project" },
              capabilities: {
                ...backingClient.capabilities,
                hosting: {
                  host_generation: `remote-${connects}`,
                  default_owner: "remote-owner",
                },
                local_host: undefined,
              },
              localHost: undefined,
              close: async () => {
                if (clientClosed) return;
                clientClosed = true;
                lifecycle.push(`close-${connects}`);
                active--;
                closed.resolve("SSH transport closed");
              },
            },
            closed: closed.promise,
          };
        },
      },
    );
    try {
      const failures: string[] = [];
      manager.subscribeConnectionFailure((reason) => failures.push(reason));
      expect(manager.defaultOwner).toBe("remote-owner");
      expect(manager.current.path).toBe("/srv/remote/project");
      expect(JSON.stringify(launches[0])).toContain("operator@example.test");
      await manager.recover(manager.current.id);
      expect(connects).toBe(2);
      expect(lifecycle.slice(0, 3)).toEqual(["connect-1", "close-1", "connect-2"]);
      expect(failures).toEqual([]);
      await expect(manager.invalidate(manager.current.id)).rejects.toThrow("reload is unavailable");
      closures[1]!.resolve("remote pipe ended");
      await Promise.resolve();
      expect(failures).toEqual(["remote pipe ended"]);
    } finally {
      await manager.close();
      await backing.close();
    }
  });
});
