import { describe, expect, it } from "bun:test";

import {
  launchIsolatedRuntime,
  RUNTIME_PROTOCOL_REVISION,
  type RuntimeBackend,
  type RuntimeInfo,
  type RuntimeLaunchSpec,
} from "../../src/index.ts";

const settings = {
  backend: "podman" as const,
  image_digest: `sha256:${"a".repeat(64)}`,
  network: "none" as const,
  executable: "/usr/bin/podman",
  connection: "local",
  limits: {
    cpu_count: 1,
    memory_bytes: 1024,
    process_count: 8,
    output_bytes: 1024,
    storage_bytes: 2048,
  },
};

const common = {
  settings,
  generation: "generation-1",
  ownerId: "owner-1",
  project: { id: "project-1" },
  workspace: {
    id: "workspace-1",
    projectId: "project-1",
    label: "workspace",
    kind: "external_worktree" as const,
  },
  workspaceRoot: "/work/tree",
  readOnlyWorkspacePaths: ["/work/tree/.clarvis/memory"],
  gitCommonDir: "/repos/project/.git",
  configurationRevision: "config-1",
  extensionRevision: "extensions-1",
  capabilityMethods: ["memory.read"],
};

function info(spec: RuntimeLaunchSpec): RuntimeInfo {
  return {
    kind: "container",
    generation: spec.generation,
    engine: "podman",
    engineVersion: "5",
    hostPlatform: "linux",
    guestPlatform: "linux",
    imageDigest: spec.imageDigest,
    runtimeProtocolRevision: RUNTIME_PROTOCOL_REVISION,
    network: spec.network,
    limits: spec.limits,
    lifecycle: "ready",
  };
}

describe("isolated runtime controller", () => {
  it("mounts the selected workspace directly and stops the generation once", async () => {
    let launched: RuntimeLaunchSpec | undefined;
    let stops = 0;
    const backend: RuntimeBackend = {
      async inspect() {
        return { available: true, engineVersion: "5", rootless: true };
      },
      async start(spec) {
        launched = spec;
        return {
          closed: false,
          info: info(spec),
          async startRun() {},
          async callHookMcp() {},
          async elicitMcp() {},
          async steer() {},
          async cancel() {},
          async exposePort() {
            throw new Error("not exercised");
          },
          async stop() {
            stops += 1;
          },
        };
      },
    };

    const controller = await launchIsolatedRuntime({ ...common, backend });
    expect(launched).toMatchObject({
      workspaceRoot: common.workspaceRoot,
      readOnlyWorkspacePaths: common.readOnlyWorkspacePaths,
      gitCommonDir: common.gitCommonDir,
    });
    await controller.close();
    await controller.close();
    expect(stops).toBe(1);
  });

  it("propagates launch and cleanup failures without a copy-state side channel", async () => {
    await expect(
      launchIsolatedRuntime({
        ...common,
        backend: {
          inspect: async () => ({ available: true, engineVersion: "5", rootless: true }),
          start: async () => Promise.reject(new Error("start failed")),
        },
      }),
    ).rejects.toThrow("start failed");

    let stopAttempts = 0;
    const controller = await launchIsolatedRuntime({
      ...common,
      backend: {
        inspect: async () => ({ available: true, engineVersion: "5", rootless: true }),
        async start(spec) {
          return {
            closed: false,
            info: info(spec),
            async startRun() {},
            async callHookMcp() {},
            async elicitMcp() {},
            async steer() {},
            async cancel() {},
            async exposePort() {
              throw new Error("not exercised");
            },
            async stop() {
              stopAttempts += 1;
              if (stopAttempts === 1) throw new Error("stop failed");
            },
          };
        },
      },
    });
    await expect(controller.close()).rejects.toThrow("stop failed");
    await expect(controller.close()).resolves.toBeUndefined();
    await controller.close();
    expect(stopAttempts).toBe(2);
  });
});
