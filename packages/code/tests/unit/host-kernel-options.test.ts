import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@clarvis/kernel/logger";
import type { FileKernelRuntimeFactory } from "@clarvis/kernel/bootstrap";
import {
  codeHostEnvironment,
  createCodeHostKernelOptions,
  type CodeHostRuntimeDependencies,
} from "../../src/adapters/host-kernel-options.ts";

type RuntimeInput = Parameters<FileKernelRuntimeFactory["create"]>[0];

function runtimeHost(
  engine: "podman" | "docker",
): Awaited<ReturnType<FileKernelRuntimeFactory["create"]>> {
  return {
    closed: false,
    info: {
      kind: "container",
      generation: engine,
      engine,
      engineVersion: "test",
      hostPlatform: process.platform,
      guestPlatform: "linux",
      imageDigest: `sha256:${"d".repeat(64)}`,
      runtimeProtocolRevision: "test",
      network: "none",
      limits: {
        cpuCount: 1,
        memoryBytes: 1,
        processCount: 1,
        outputBytes: 1,
        storageBytes: 1,
      },
      lifecycle: "ready",
    },
    executeRun: async () => {
      throw new Error("execution is outside this composition test");
    },
    close: async () => {},
  };
}

describe("code host kernel options", () => {
  it("uses one tool ceiling default for launcher identity and host construction", () => {
    expect(codeHostEnvironment({ HOME: "/home/operator" })).toEqual({
      HOME: "/home/operator",
      CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec",
    });
    expect(codeHostEnvironment({ CLARVIS_AGENT_TOOLS_MAX_GRANT: "read" })).toEqual({
      CLARVIS_AGENT_TOOLS_MAX_GRANT: "read",
    });
  });

  it("shares host policy across local and remote transports without inventing identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-code-host-options-"));
    const logger = createLogger("silent");
    try {
      const base = createCodeHostKernelOptions({
        workspaceRoot: join(root, "workspace"),
        globalDir: join(root, "global"),
        logger,
        environment: {},
        runtimeNotice: () => {},
      });
      expect(base).toMatchObject({
        workspaceRoot: join(root, "workspace"),
        globalDir: join(root, "global"),
        memory: true,
        subscriptions: true,
        environment: {
          values: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" },
        },
        logger,
        keySources: {},
      });
      expect(base).not.toHaveProperty("defaultOwner");
      expect(base).not.toHaveProperty("extensionProfileSelector");
      expect(base.runtimeFactory).toHaveProperty("create");

      const scoped = createCodeHostKernelOptions({
        workspaceRoot: join(root, "workspace"),
        globalDir: join(root, "global"),
        defaultOwner: "owner",
        extensionProfileSelector: "global:remote",
        logger,
        environment: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "read" },
        runtimeNotice: () => {},
      });
      expect(scoped).toMatchObject({
        defaultOwner: "owner",
        extensionProfileSelector: "global:remote",
        environment: {
          values: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "read" },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("selects each lazy container adapter and forwards Docker image preparation effects", async () => {
    const notices: string[] = [];
    const podman = runtimeHost("podman");
    const docker = runtimeHost("docker");
    let resolvedSignal: AbortSignal | undefined;
    const runtimeDependencies: CodeHostRuntimeDependencies = {
      productVersion: () => "1.2.3",
      resolveRuntimeImage: async ({ currentVersion, signal }) => {
        expect(currentVersion).toBe("1.2.3");
        resolvedSignal = signal;
        return { reference: "clarvis-runtime:test", pull: false };
      },
      loadLocalRuntime: async () => ({
        createLocalPodmanRuntime: async (value) => {
          expect(value.settings.backend).toBe("podman");
          return podman;
        },
        createLocalDockerRuntime: async (value, options) => {
          expect(value.settings.backend).toBe("docker");
          if (options === undefined) throw new Error("expected Docker runtime options");
          const controller = new AbortController();
          expect(await options.resolveImage?.(controller.signal)).toEqual({
            reference: "clarvis-runtime:test",
            pull: false,
          });
          options.onRecipePreparation?.("base");
          return docker;
        },
      }),
    };
    const options = createCodeHostKernelOptions(
      {
        workspaceRoot: "/workspace",
        globalDir: "/global",
        logger: createLogger("silent"),
        runtimeNotice: (message) => notices.push(message),
      },
      runtimeDependencies,
    );

    expect(
      await options.runtimeFactory!.create({ settings: { backend: "podman" } } as RuntimeInput),
    ).toBe(podman);
    expect(
      await options.runtimeFactory!.create({ settings: { backend: "docker" } } as RuntimeInput),
    ).toBe(docker);
    expect(resolvedSignal).toBeInstanceOf(AbortSignal);
    expect(notices).toEqual(["Preparing Docker environment: base"]);
  });
});
