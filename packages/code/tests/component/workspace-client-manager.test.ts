import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";
import { ownerFromWorkspace } from "@clarvis/paths";
import { withoutGitRepositoryEnvironment } from "@clarvis/kernel/local";
import {
  connectOrLaunchLocalKernel,
  createOperatorServices,
  type LaunchedContainerKernel,
} from "@clarvis/kernel/bootstrap";
import type { KernelClient } from "@clarvis/protocol";

import {
  composeLaunchedContainerConnection,
  isContainerKernelOwnershipConflict,
  WorkspaceClientManager,
} from "../../src/adapters/workspace-client-manager.ts";
import { prepareStartupFoundation } from "../../src/startup-foundation.ts";
import { openTempDir } from "../helpers/tracked-temp.ts";
import { environmentFixture, spyOnProcessEnv } from "../helpers/process-fixtures.ts";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: withoutGitRepositoryEnvironment(process.env),
    stdio: "ignore",
  });
}

describe("WorkspaceClientManager", () => {
  it("recognizes only the typed live Container ownership conflict", () => {
    expect(
      isContainerKernelOwnershipConflict({
        code: "conflict",
        details: { kind: "container_kernel_owned", engine: "podman" },
      }),
    ).toBe(true);
    expect(
      isContainerKernelOwnershipConflict({
        code: "conflict",
        message: "Another Container Kernel owns this workspace namespace",
      }),
    ).toBe(false);
  });

  it("forwards the authenticated Container principal and closes a rejected launch", async () => {
    const root = openTempDir("clarvis-workspace-container-composition-");
    const workspaceRoot = join(root, "workspace");
    mkdirSync(workspaceRoot);
    const source = await WorkspaceClientManager.create({
      workspaceRoot,
      globalDir: join(root, "global"),
    });
    const local = (await source.open()).client;
    const principal = { id: "container-operator" };
    const workspace = { ...local.workspace, path: "/workspace" as const };
    const runtime = {
      kind: "container" as const,
      engine: "podman" as const,
      host_platform: "linux",
      guest_platform: "linux" as const,
      network: "none" as const,
      generation: crypto.randomUUID(),
      image_digest: `sha256:${"a".repeat(64)}` as const,
      artifact_digest: `sha256:${"b".repeat(64)}` as const,
      base_abi: "clarvis-linux-glibc-v1",
      broker_version: 1 as const,
      channel_version: 1 as const,
      state_namespace: "c".repeat(64),
      lifecycle: "ready" as const,
    };
    const execution: KernelClient = {
      ...local,
      workspace,
      principal,
      localHost: undefined,
      capabilities: {
        ...local.capabilities,
        skills: false,
        tasks: false,
        local_host: undefined,
        runtime,
      },
    };
    const operator = createOperatorServices({
      workspaceRoot,
      globalDir: join(root, "operator-global"),
      subscriptions: false,
    });
    let launchCloses = 0;
    const savedKinds: string[] = [];
    const launch = {
      client: execution,
      operator: {
        ...operator,
        models: {
          ...operator.models,
          refresh: async () => ({ providers: [], source: "cache" as const }),
        },
      },
      project: local.project,
      workspace,
      generation: runtime.generation,
      artifactDigest: runtime.artifact_digest,
      configDigest: `sha256:${"d".repeat(64)}` as const,
      closed: new Promise<string>(() => {}),
      stderr: () => "",
      revokeModelPair: () => undefined,
      close: async () => {
        launchCloses++;
      },
    } satisfies LaunchedContainerKernel;
    const connection = await composeLaunchedContainerConnection(launch);
    const unsubscribe = connection.subscribeConfigurationSaved!((kind) => savedKinds.push(kind));
    expect(connection.client.principal).toEqual(principal);
    await connection.client.models.refresh();
    expect(savedKinds).toEqual(["models"]);
    unsubscribe();
    await connection.client.close();
    expect(launchCloses).toBe(1);

    await expect(
      composeLaunchedContainerConnection({
        ...launch,
        client: {
          ...execution,
          capabilities: {
            ...execution.capabilities,
            runtime: {
              kind: "native",
              host_platform: "linux",
              isolation: "sandbox",
              lifecycle: "ready",
            },
          },
        },
      }),
    ).rejects.toThrow("did not report Container placement");
    expect(launchCloses).toBe(2);
    await operator.close();
    await source.close();
  });

  it("selects Container before connecting and resolves its release for the engine target", async () => {
    const root = openTempDir("clarvis-workspace-container-destination-");
    const workspaceRoot = join(root, "workspace");
    const globalDir = join(root, "global");
    mkdirSync(workspaceRoot);
    mkdirSync(globalDir);
    writeFileSync(
      join(globalDir, "settings.json"),
      JSON.stringify({ runtime: { backend: "podman", network: "none" } }),
    );
    let selectedTarget = "";
    let receivedOwner = "";
    let configurationSaved:
      ((kind: "settings" | "agents" | "context" | "models") => void) | undefined;
    const source = await WorkspaceClientManager.create({
      workspaceRoot,
      globalDir: join(root, "local-global"),
      defaultOwner: "container-owner",
    });
    const local = (await source.open()).client;
    const controls = local.localHost!;
    const client = {
      ...local,
      localHost: undefined,
      capabilities: {
        ...local.capabilities,
        hosting: { ...local.capabilities.hosting!, default_owner: "container-owner" },
        runtime: {
          kind: "container" as const,
          engine: "podman" as const,
          host_platform: "linux",
          guest_platform: "linux",
          network: "none" as const,
          generation: crypto.randomUUID(),
          image_digest: `sha256:${"a".repeat(64)}`,
          artifact_digest: `sha256:${"b".repeat(64)}`,
          base_abi: "clarvis-linux-glibc-v1",
          broker_version: 1 as const,
          channel_version: 1 as const,
          state_namespace: "c".repeat(64),
          lifecycle: "ready" as const,
        },
      },
    } satisfies KernelClient;
    const manager = await WorkspaceClientManager.create(
      {
        workspaceRoot,
        globalDir,
        defaultOwner: "container-owner",
        destination: { kind: "container" },
      },
      {
        resolveContainerRelease: async ({ target }) => {
          selectedTarget = target;
          return {
            base: { reference: "clarvis-base:local", pull: false },
            artifact: {
              source: { kind: "local", archivePath: join(root, "fixture.tar.gz") },
              selection: {
                productVersion: "0.0.1-beta",
                sourceRevision: "d".repeat(40),
                target,
                baseAbi: "clarvis-linux-glibc-v1",
                digest: `sha256:${"e".repeat(64)}`,
                size: 1,
              },
            },
          };
        },
        connectContainerHost: async (options) => {
          receivedOwner = options.owner;
          await options.resolveRelease!("linux-x64");
          return {
            client,
            subscribeConfigurationSaved: (listener) => {
              configurationSaved = listener;
              return () => {
                configurationSaved = undefined;
              };
            },
          };
        },
      },
    );
    try {
      const revisions: number[] = [];
      const placements: string[] = [];
      const unsubscribe = manager.subscribeSkillsChanged((revision) => revisions.push(revision));
      const unsubscribePlacement = manager.subscribeRuntimePlacement((notice) =>
        placements.push(
          `${notice.pendingReconnect === true ? "pending:" : ""}${notice.message ?? notice.status.kind}`,
        ),
      );
      expect(manager.defaultOwner).toBe("container-owner");
      expect(manager.backgroundHandoffSurvivesExit).toBe(false);
      expect((await manager.open()).client.localHost).toBeUndefined();
      expect(selectedTarget).toBe("linux-x64");
      expect(receivedOwner).toBe("container-owner");
      expect(revisions).toEqual([0]);
      configurationSaved?.("models");
      expect(placements.at(-1)).toContain("pending:Model catalog saved on the host");
      expect(placements.at(-1)).toContain("until reconnect");
      unsubscribe();
      unsubscribePlacement();
    } finally {
      await manager.close();
      expect(manager.subscribeSkillsChanged(() => undefined)).toBeFunction();
      await controls.requestRestart();
      await source.close();
    }
  });

  it("re-selects and retires the host when isolation changes between local and Container", async () => {
    const root = openTempDir("clarvis-workspace-placement-transition-");
    const workspaceRoot = join(root, "workspace");
    const globalDir = join(root, "global");
    const backingGlobal = join(root, "backing-global");
    mkdirSync(workspaceRoot);
    mkdirSync(globalDir);
    const backing = await WorkspaceClientManager.create({
      workspaceRoot,
      globalDir: backingGlobal,
    });
    const backingClient = (await backing.open()).client;
    const owner = ownerFromWorkspace(workspaceRoot);
    let containerClosed = 0;
    const containerClient: KernelClient = {
      ...backingClient,
      memory: {
        ...backingClient.memory,
        jobs: async () => ({
          jobs: [],
          counts: {
            pending: 1,
            running: 0,
            retry_wait: 0,
            completed: 0,
            failed: 0,
          },
        }),
      },
      hosting: {
        ...backingClient.hosting!,
        list: async () => [
          {
            execution_id: "old-unknown-run",
            session_id: "old-session",
            workspace_id: "workspace",
            host_generation: crypto.randomUUID(),
            title: "Recovered uncertain run",
            revision: 1,
            disconnect_policy: "cancel",
            execution_state: "unknown",
            attention: "none",
            control_epoch: 1,
            control: "available",
            config: { agent: "fixture" },
            created_at: 1,
            updated_at: 1,
          },
        ],
      },
      localHost: undefined,
      capabilities: {
        ...backingClient.capabilities,
        hosting: { host_generation: crypto.randomUUID(), default_owner: owner },
        local_host: undefined,
        runtime: {
          kind: "container",
          engine: "podman",
          host_platform: "linux",
          guest_platform: "linux",
          network: "none",
          generation: crypto.randomUUID(),
          image_digest: `sha256:${"a".repeat(64)}`,
          artifact_digest: `sha256:${"b".repeat(64)}`,
          base_abi: "clarvis-linux-glibc-v1",
          broker_version: 1,
          channel_version: 1,
          state_namespace: "c".repeat(64),
          lifecycle: "ready",
        },
      },
      close: async () => {
        containerClosed += 1;
      },
    };
    const manager = await WorkspaceClientManager.create(
      { workspaceRoot, globalDir },
      { connectContainerHost: async () => ({ client: containerClient }) },
    );
    try {
      const initial = (await manager.open()).client;
      expect(manager.backgroundHandoffSurvivesExit).toBe(true);
      expect(initial.localHost).toBeDefined();
      const placements: string[] = [];
      const connectionFailures: string[] = [];
      manager.subscribeRuntimePlacement((notice) => placements.push(notice.status.kind));
      manager.subscribeConnectionFailure((reason) => connectionFailures.push(reason));

      writeFileSync(
        join(globalDir, "settings.json"),
        JSON.stringify({ runtime: { backend: "podman", network: "none" } }),
      );
      await manager.invalidate(manager.current.id);
      const container = (await manager.open()).client;
      expect(manager.backgroundHandoffSurvivesExit).toBe(false);
      expect(container.localHost).toBeUndefined();
      expect(container.capabilities.runtime?.kind).toBe("container");
      expect(placements.at(-1)).toBe("container");
      expect(connectionFailures).toEqual([]);
      await expect(initial.localHost!.inspect()).rejects.toThrow();

      writeFileSync(
        join(globalDir, "settings.json"),
        JSON.stringify({ runtime: { backend: "native" } }),
      );
      await manager.invalidate(manager.current.id);
      const local = (await manager.open()).client;
      expect(manager.backgroundHandoffSurvivesExit).toBe(true);
      expect(containerClosed).toBe(1);
      expect(local.localHost).toBeDefined();
      expect(local.capabilities.runtime?.kind).not.toBe("container");
      expect(placements.at(-1)).not.toBe("container");
      await local.localHost!.requestRestart();
    } finally {
      await manager.close();
      await backingClient.localHost!.requestRestart();
      await backing.close();
    }
  });

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
    const ambient = environmentFixture();
    const env = spyOnProcessEnv(ambient);
    let manager: WorkspaceClientManager | undefined;
    try {
      env.mockReturnValue(
        environmentFixture({
          ...ambient,
          CLARVIS_HOME: join(root, "global"),
          CLARVIS_WORKSPACE_ROOT: workspace,
          CLARVIS_OWNER: "startup-owner",
        }),
      );
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

      env.mockReturnValue(
        environmentFixture({
          ...ambient,
          CLARVIS_HOME: join(root, "global"),
          CLARVIS_WORKSPACE_ROOT: workspace,
          CLARVIS_OWNER: undefined,
        }),
      );
      manager = await prepareStartupFoundation({
        kind: "run",
        ascii: false,
        debug: { enabled: false },
      });
      expect(manager.defaultOwner).toBe(ownerFromWorkspace(workspace));
    } finally {
      await manager?.close();
      env.mockRestore();
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
        destination: {
          kind: "ssh",
          destination: "operator@example.test",
          workspace: "/srv/remote/project",
        },
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
      expect(manager.backgroundHandoffSurvivesExit).toBe(false);
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
