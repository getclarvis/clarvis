import { afterEach, describe, expect, test, vi } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Transform } from "node:stream";
import { envSchema } from "@clarvis/capability";
import { projectContainerConfiguration } from "../../src/config/container-projection.ts";
import { serveContainerKernel } from "../../src/hosting/container-bootstrap.ts";
import { connectContainerKernel } from "../../src/hosting/container-launcher.ts";
import {
  containerModelResponseLimit,
  launchContainerKernel,
} from "../../src/hosting/container-host-launcher.ts";
import { createOperatorServices } from "../../src/config/operator-services.ts";
import type { RuntimeArtifactManifest } from "../../src/runtime/runtime-artifact.ts";
import type { ContainerKernelLaunchSpec } from "../../src/runtime/types.ts";
import { containerLaunchPaths, type LocalLease } from "@clarvis/paths";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function manifest(): RuntimeArtifactManifest {
  return {
    schemaVersion: 1,
    productVersion: "0.0.1-beta",
    sourceRevision: "a".repeat(40),
    dirty: true,
    target: process.arch === "arm64" ? "linux-arm64" : "linux-x64",
    baseAbi: "clarvis-linux-glibc-v1",
    kernelWireVersion: 10,
    brokerVersion: 1,
    channelVersion: 1,
    entrypoint: "bin/clarvis-kernel",
    files: [
      { path: "LICENSE", size: 1, sha256: "b".repeat(64), executable: false },
      { path: "bin/clarvis-kernel", size: 1, sha256: "c".repeat(64), executable: true },
    ],
  };
}

describe("Container Kernel process connection", () => {
  test("caps model responses by the lower provider and launch ceiling", () => {
    expect(containerModelResponseLimit(32 * 1024 * 1024, 4096)).toBe(4096);
    expect(containerModelResponseLimit(2048, 4096)).toBe(2048);
  });

  test("rejects invalid boot bounds, mismatched authority and sanitized guest diagnostics", async () => {
    const configuration = projectContainerConfiguration({
      store: {
        readSettings: () => ({ merged: {}, operator_merged: {}, scopes: {}, sources: [] }),
        listAgents: () => [],
      },
      env: envSchema.parse({}),
      modelCatalog: [],
      sharedPrompt: "",
      contexts: [],
      memoryPolicy: "",
      workflowDefinitions: [],
    });
    const digest = `sha256:${"d".repeat(64)}` as const;
    const lifecycle = () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      return {
        id: "a".repeat(64),
        process: {
          stdin,
          stdout,
          stderr,
          exited: Promise.resolve(1),
          kill: () => undefined,
        },
        stop: async () => undefined,
        kill: async () => undefined,
        remove: async () => undefined,
      };
    };
    const initialize = {
      workspaceIdentity: {
        project: { id: "project" },
        workspace: {
          id: "workspace",
          projectId: "project",
          label: "fixture",
          kind: "primary" as const,
          path: "/workspace" as const,
        },
        namespace: "e".repeat(64),
      },
      owner: "fixture",
      runtime: {
        engine: "podman" as const,
        hostPlatform: "linux" as const,
        network: "none" as const,
        baseDigest: `sha256:${"f".repeat(64)}` as const,
        baseAbi: "clarvis-linux-glibc-v1" as const,
      },
      artifactDigest: digest,
      configDigest: (
        await import("../../src/config/container-projection.ts")
      ).containerConfigurationDigest(configuration),
      configuration,
    };
    const broker = {
      owner: "fixture",
      namespace: "e".repeat(64),
      modelCatalog: [],
      maxConcurrent: 1,
      maxQueued: 0,
      tokenCeiling: 1,
      hostMaxRetries: 0,
      maxResponseBytes: 1024,
      maxTimeoutMs: 1000,
      defaultTimeoutMs: 1000,
      resolve: async () => {
        throw new Error("unexpected model resolution");
      },
    };
    await expect(
      connectContainerKernel({ lifecycle: lifecycle(), initialize, broker, timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      connectContainerKernel({
        lifecycle: lifecycle(),
        initialize: { ...initialize, owner: "other" },
        broker,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const failed = lifecycle();
    failed.process.stderr.write("\u001b[31mprovider secret\tfailed\u001b[0m\n");
    failed.process.stdout.end("WRONG\n");
    await expect(
      connectContainerKernel({ lifecycle: failed, initialize, broker, timeoutMs: 50 }),
    ).rejects.toThrow("provider secret failed");
  });

  test.each([false, true])(
    "initializes once, negotiates the public Kernel and escalates an unconfirmed stop (stop failure: %s)",
    async (stopFails) => {
      const root = await mkdtemp(join(tmpdir(), "clarvis-container-launcher-"));
      roots.push(root);
      const workspaceRoot = join(root, "workspace");
      const globalDir = join(root, "state");
      await Promise.all([mkdir(workspaceRoot), mkdir(globalDir)]);
      const hostToGuest = new PassThrough();
      const guestToHost = new PassThrough();
      const guest = serveContainerKernel({
        input: hostToGuest,
        output: guestToHost,
        workspaceRoot,
        globalDir,
        artifactManifest: manifest(),
      });
      const exited = Promise.withResolvers<number | null>();
      let removed = 0;
      let stopped = 0;
      let killed = 0;
      const configuration = projectContainerConfiguration({
        store: {
          readSettings: () => ({ merged: {}, operator_merged: {}, scopes: {}, sources: [] }),
          listAgents: () => [],
        },
        env: envSchema.parse({ CLARVIS_OWNER: "fixture" }),
        modelCatalog: [],
        sharedPrompt: "",
        contexts: [],
        memoryPolicy: "",
        workflowDefinitions: [],
      });
      const digest = `sha256:${"d".repeat(64)}` as const;
      const connecting = connectContainerKernel({
        lifecycle: {
          id: "a".repeat(64),
          process: {
            stdin: hostToGuest,
            stdout: guestToHost,
            stderr: new PassThrough(),
            exited: exited.promise,
            kill: () => exited.resolve(null),
          },
          stop: async () => {
            stopped++;
            if (stopFails) throw new Error("engine stop failed");
          },
          kill: async () => {
            killed++;
            exited.resolve(null);
          },
          remove: async () => {
            removed++;
          },
        },
        initialize: {
          workspaceIdentity: {
            project: { id: "project" },
            workspace: {
              id: "workspace",
              projectId: "project",
              label: "fixture",
              kind: "primary",
              path: "/workspace",
            },
            namespace: "e".repeat(64),
          },
          owner: "fixture",
          runtime: {
            engine: "podman",
            hostPlatform: "linux",
            network: "none",
            baseDigest: `sha256:${"f".repeat(64)}`,
            baseAbi: "clarvis-linux-glibc-v1",
          },
          artifactDigest: digest,
          configDigest: (
            await import("../../src/config/container-projection.ts")
          ).containerConfigurationDigest(configuration),
          configuration,
        },
        broker: {
          owner: "fixture",
          namespace: "e".repeat(64),
          modelCatalog: [],
          maxConcurrent: 1,
          maxQueued: 0,
          tokenCeiling: 1,
          hostMaxRetries: 0,
          maxResponseBytes: 1024,
          maxTimeoutMs: 1000,
          defaultTimeoutMs: 1000,
          resolve: async () => {
            throw new Error("unexpected model resolution");
          },
        },
      });
      const [, connection] = await Promise.all([guest.initialized, connecting]);
      expect(connection.client.project.id).toBe("project");
      expect(connection.client.workspace.id).toBe("workspace");
      expect(connection.client.localHost).toBeUndefined();
      expect(connection.client.capabilities.runtime?.kind).toBe("container");
      await expect(
        connection.client.config.updateSettings("workspace", {}, null),
      ).rejects.toMatchObject({ code: "unsupported" });
      vi.useFakeTimers();
      try {
        const closing = connection.close();
        for (let phase = 0; phase < 3; phase++) {
          await new Promise<void>((resolve) => process.nextTick(resolve));
          vi.advanceTimersByTime(30_000);
        }
        await closing;
      } finally {
        vi.useRealTimers();
      }
      await guest.close();
      expect({ stopped, killed, removed }).toEqual({ stopped: 1, killed: 1, removed: 1 });
    },
  );

  test("uses one deadline across prefix, initialization and public hello", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-container-deadline-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const globalDir = join(root, "state");
    await Promise.all([mkdir(workspaceRoot), mkdir(globalDir)]);
    const hostToGuest = new PassThrough();
    const delayedGuestToHost = new Transform({
      transform(chunk, _encoding, callback) {
        const timer = setTimeout(() => callback(null, chunk), 30);
        timer.unref?.();
      },
    });
    const guest = serveContainerKernel({
      input: hostToGuest,
      output: delayedGuestToHost,
      workspaceRoot,
      globalDir,
      artifactManifest: manifest(),
    });
    const exited = Promise.withResolvers<number | null>();
    void guest.closed.then(() => exited.resolve(0));
    const configuration = projectContainerConfiguration({
      store: {
        readSettings: () => ({ merged: {}, operator_merged: {}, scopes: {}, sources: [] }),
        listAgents: () => [],
      },
      env: envSchema.parse({ CLARVIS_OWNER: "fixture" }),
      modelCatalog: [],
      sharedPrompt: "",
      contexts: [],
      memoryPolicy: "",
      workflowDefinitions: [],
    });
    const artifactDigest = `sha256:${"d".repeat(64)}` as const;
    await expect(
      connectContainerKernel({
        lifecycle: {
          id: "a".repeat(64),
          process: {
            stdin: hostToGuest,
            stdout: delayedGuestToHost,
            stderr: new PassThrough(),
            exited: exited.promise,
            kill: () => exited.resolve(null),
          },
          stop: async () => exited.resolve(null),
          kill: async () => exited.resolve(null),
          remove: async () => undefined,
        },
        initialize: {
          workspaceIdentity: {
            project: { id: "project" },
            workspace: {
              id: "workspace",
              projectId: "project",
              label: "fixture",
              kind: "primary",
              path: "/workspace",
            },
            namespace: "e".repeat(64),
          },
          owner: "fixture",
          runtime: {
            engine: "podman",
            hostPlatform: "linux",
            network: "none",
            baseDigest: `sha256:${"f".repeat(64)}`,
            baseAbi: "clarvis-linux-glibc-v1",
          },
          artifactDigest,
          configDigest: (
            await import("../../src/config/container-projection.ts")
          ).containerConfigurationDigest(configuration),
          configuration,
        },
        broker: {
          owner: "fixture",
          namespace: "e".repeat(64),
          modelCatalog: [],
          maxConcurrent: 1,
          maxQueued: 0,
          tokenCeiling: 1,
          hostMaxRetries: 0,
          maxResponseBytes: 1024,
          maxTimeoutMs: 1000,
          defaultTimeoutMs: 1000,
          resolve: async () => {
            throw new Error("unexpected model resolution");
          },
        },
        timeoutMs: 70,
      }),
    ).rejects.toThrow("boot timed out");
    await guest.close();
  });

  test("the host launcher owns the lease, registry, operator facade and native guest", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-container-host-launcher-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const globalDir = join(root, "global");
    await Promise.all([mkdir(workspaceRoot), mkdir(globalDir)]);
    const generation = crypto.randomUUID();
    const namespace = "e".repeat(64);
    const digest = `sha256:${"d".repeat(64)}` as const;
    const launch: ContainerKernelLaunchSpec = {
      generation,
      namespace,
      workspaceRoot,
      controlRootMasks: [],
      gitMetadataMounts: [],
      baseImageId: `sha256:${"f".repeat(64)}`,
      baseAbi: "clarvis-linux-glibc-v1",
      artifact: { volume: "artifact", digest, target: manifest().target },
      data: { contentVolume: "content", stateVolume: "state" },
      miseVolume: "mise",
      network: "none",
      limits: {
        cpuCount: 1,
        memoryBytes: 1024,
        processCount: 16,
        outputBytes: 1024,
        storageBytes: 1024,
      },
      user: { uid: 1000, gid: 1000 },
    };
    const configuration = projectContainerConfiguration({
      store: {
        readSettings: () => ({ merged: {}, operator_merged: {}, scopes: {}, sources: [] }),
        listAgents: () => [],
      },
      env: envSchema.parse({ CLARVIS_OWNER: "fixture" }),
      modelCatalog: [
        {
          provider: "logical",
          model: "model-v1",
          kind: "openai-compatible",
          contextWindowTokens: 8192,
          maxOutputTokens: 1024,
          capabilities: undefined,
          reasoningEfforts: undefined,
          promptCache: undefined,
        },
      ],
      sharedPrompt: "",
      contexts: [],
      memoryPolicy: "",
      workflowDefinitions: [],
    });
    let released = 0;
    let mountCleanup = 0;
    let removed = 0;
    let guestHost: ReturnType<typeof serveContainerKernel> | undefined;
    const cleanupCompleted = Promise.withResolvers<void>();
    const lease = {
      path: join(root, "lease"),
      record: { schema: 1, pid: process.pid, token: "fixture", createdAt: 1 },
      renew: async () => true,
      owned: async () => true,
      assertOwned: async () => undefined,
      release: async () => {
        released++;
        cleanupCompleted.resolve();
        return true;
      },
    } as unknown as LocalLease;
    await writeFile(
      join(globalDir, "settings.json"),
      `${JSON.stringify({
        providers: [
          {
            name: "logical",
            kind: "openai-compatible",
            base_url: "https://provider.invalid/v1",
            api_key_env: "FIXTURE_KEY",
            models: { "model-v1": { context_window_tokens: 8192, max_output_tokens: 1024 } },
          },
        ],
      })}\n`,
    );
    const operator = createOperatorServices({
      workspaceRoot,
      globalDir,
      subscriptions: false,
    });
    let reconciled = 0;
    await mkdir(containerLaunchPaths(namespace, globalDir).root, { recursive: true });
    await writeFile(
      containerLaunchPaths(namespace, globalDir).registryFile,
      `${JSON.stringify({
        schema: 1,
        engine: "podman",
        containerId: "5".repeat(64),
        generation: crypto.randomUUID(),
      })}\n`,
    );
    const backend = {
      inspect: async () => ({ available: true as const, engineVersion: "fixture", rootless: true }),
      reconcilePrevious: async () => {
        reconciled++;
      },
      startKernel: async () => {
        const hostToGuest = new PassThrough();
        const guestToHost = new PassThrough();
        const guest = serveContainerKernel({
          input: hostToGuest,
          output: guestToHost,
          workspaceRoot,
          globalDir,
          artifactManifest: manifest(),
        });
        guestHost = guest;
        const exited = Promise.withResolvers<number | null>();
        void guest.closed.then(() => exited.resolve(0));
        return {
          id: "a".repeat(64),
          process: {
            stdin: hostToGuest,
            stdout: guestToHost,
            stderr: new PassThrough(),
            exited: exited.promise,
            kill: () => exited.resolve(null),
          },
          stop: async () => exited.resolve(null),
          kill: async () => exited.resolve(null),
          remove: async () => {
            removed++;
          },
        };
      },
    };
    const launched = await launchContainerKernel({
      backend,
      engine: "podman",
      launch,
      artifact: {
        root,
        archivePath: join(root, "artifact.tar.gz"),
        entrypoint: "bin/clarvis-kernel",
        manifest: manifest(),
      },
      configuration,
      project: { id: "project" },
      workspace: {
        id: "workspace",
        projectId: "project",
        label: "fixture",
        kind: "primary",
        path: "/workspace",
      },
      owner: "fixture",
      globalDir,
      env: envSchema.parse({ CLARVIS_OWNER: "fixture" }),
      protectedMounts: {
        controlRootMasks: [],
        gitMetadataMounts: [],
        cleanup: async () => {
          mountCleanup++;
        },
      },
      operator,
      lease,
    });
    expect(launched.client.capabilities.runtime?.kind).toBe("container");
    expect(launched.operator).toBe(operator);
    expect(launched.workspace.path).toBe("/workspace");
    await launched.operator.secrets.set("FIXTURE_KEY", "revoked");
    await guestHost!.close();
    await cleanupCompleted.promise;
    await launched.close();
    expect({ released, mountCleanup, removed, reconciled }).toEqual({
      released: 1,
      mountCleanup: 1,
      removed: 1,
      reconciled: 1,
    });
  });

  test("host launch failures close only admitted resources and preserve the primary error", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-container-host-failure-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const globalDir = join(root, "global");
    await Promise.all([mkdir(workspaceRoot), mkdir(globalDir)]);
    const namespace = "9".repeat(64);
    const digest = `sha256:${"8".repeat(64)}` as const;
    const launch: ContainerKernelLaunchSpec = {
      generation: crypto.randomUUID(),
      namespace,
      workspaceRoot,
      controlRootMasks: [],
      gitMetadataMounts: [],
      baseImageId: `sha256:${"7".repeat(64)}`,
      baseAbi: "clarvis-linux-glibc-v1",
      artifact: { volume: "artifact", digest, target: manifest().target },
      data: { contentVolume: "content", stateVolume: "state" },
      miseVolume: "mise",
      network: "none",
      limits: {
        cpuCount: 1,
        memoryBytes: 1024,
        processCount: 16,
        outputBytes: 1024,
        storageBytes: 1024,
      },
      user: { uid: 1000, gid: 1000 },
    };
    const configuration = projectContainerConfiguration({
      store: {
        readSettings: () => ({ merged: {}, operator_merged: {}, scopes: {}, sources: [] }),
        listAgents: () => [],
      },
      env: envSchema.parse({}),
      modelCatalog: [],
      sharedPrompt: "",
      contexts: [],
      memoryPolicy: "",
      workflowDefinitions: [],
    });
    const artifact = {
      root,
      archivePath: join(root, "artifact.tar.gz"),
      entrypoint: "bin/clarvis-kernel" as const,
      manifest: manifest(),
    };
    const workspace = {
      id: "workspace",
      projectId: "project",
      label: "fixture",
      kind: "primary" as const,
      path: "/workspace" as const,
    };
    let released = 0;
    let cleaned = 0;
    const lease = {
      assertOwned: async () => undefined,
      release: async () => {
        released++;
        return true;
      },
    } as LocalLease;
    const protectedMounts = {
      controlRootMasks: [],
      gitMetadataMounts: [],
      cleanup: async () => {
        cleaned++;
      },
    };
    const unavailableOperator = createOperatorServices({
      workspaceRoot,
      globalDir,
      subscriptions: false,
    });
    await expect(
      launchContainerKernel({
        backend: {
          inspect: async () => ({
            available: false,
            reason: "engine_stopped",
            message: "engine stopped",
          }),
          reconcilePrevious: async () => undefined,
          startKernel: async () => {
            throw new Error("unexpected start");
          },
        },
        engine: "podman",
        launch,
        artifact,
        configuration,
        project: { id: "project" },
        workspace,
        owner: "fixture",
        globalDir,
        env: envSchema.parse({}),
        protectedMounts,
        operator: unavailableOperator,
        lease,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect({ released, cleaned }).toEqual({ released: 1, cleaned: 1 });

    const lifecycleOperator = createOperatorServices({
      workspaceRoot,
      globalDir,
      subscriptions: false,
    });
    const operatorWithoutSettings = {
      ...lifecycleOperator,
      configStore: {
        ...lifecycleOperator.configStore,
        readSettings: () => ({ merged: {}, scopes: {}, sources: [] }),
      },
    };
    let stopped = 0;
    let removed = 0;
    const processExit = Promise.withResolvers<number | null>();
    const processStreams = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exited: processExit.promise,
      kill: () => processExit.resolve(null),
    };
    await expect(
      launchContainerKernel({
        backend: {
          inspect: async () => ({ available: true, engineVersion: "fixture", rootless: true }),
          reconcilePrevious: async () => undefined,
          startKernel: async () => ({
            id: "6".repeat(64),
            process: processStreams,
            stop: async () => {
              stopped++;
              processExit.resolve(null);
            },
            kill: async () => processExit.resolve(null),
            remove: async () => {
              removed++;
            },
          }),
        },
        engine: "podman",
        launch: { ...launch, generation: crypto.randomUUID() },
        artifact,
        configuration,
        project: { id: "project" },
        workspace,
        owner: "fixture",
        globalDir,
        env: envSchema.parse({}),
        protectedMounts: { ...protectedMounts, cleanup: async () => undefined },
        operator: operatorWithoutSettings,
        lease: { ...lease, release: async () => true },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect({ stopped, removed }).toEqual({ stopped: 1, removed: 1 });

    const registry = containerLaunchPaths(namespace, globalDir).registryFile;
    await writeFile(registry, "not-json\n");
    const registryOperator = createOperatorServices({
      workspaceRoot,
      globalDir,
      subscriptions: false,
    });
    await expect(
      launchContainerKernel({
        backend: {
          inspect: async () => ({ available: true, engineVersion: "fixture", rootless: true }),
          reconcilePrevious: async () => undefined,
          startKernel: async () => {
            throw new Error("unexpected start");
          },
        },
        engine: "podman",
        launch,
        artifact,
        configuration,
        project: { id: "project" },
        workspace,
        owner: "fixture",
        globalDir,
        env: envSchema.parse({}),
        protectedMounts: { ...protectedMounts, cleanup: async () => undefined },
        operator: registryOperator,
        lease: { ...lease, release: async () => true },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
