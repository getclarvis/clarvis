import { describe, expect, test } from "bun:test";

import {
  createRuntimeSupervisor,
  RuntimeLaunchError,
  type RuntimeBackend,
  type RuntimeInfo,
  type RuntimeLaunchSpec,
} from "../../src/index.ts";

const digest = `sha256:${"b".repeat(64)}`;
const spec: RuntimeLaunchSpec = {
  generation: "runtime-1",
  ownerId: "owner-1",
  project: { id: "project-1" },
  workspace: { id: "workspace-1", projectId: "project-1", label: "primary", kind: "primary" },
  sourceWorkspaceRoot: "/work/source",
  retainedWorkspaceRoot: "/state/runtime/workspace",
  imageDigest: digest,
  configurationRevision: "config-1",
  extensionRevision: "extensions-1",
  network: "none",
  limits: {
    cpuCount: 1,
    memoryBytes: 1024,
    processCount: 10,
    outputBytes: 1024,
    storageBytes: 2048,
  },
  capabilityMethods: ["memory.search"],
};

function info(overrides: Partial<RuntimeInfo> = {}): RuntimeInfo {
  return {
    kind: "container",
    generation: spec.generation,
    engine: "podman",
    engineVersion: "5.0.0",
    hostPlatform: process.platform,
    guestPlatform: "linux",
    imageDigest: spec.imageDigest,
    runtimeProtocolRevision: "2",
    network: spec.network,
    limits: spec.limits,
    lifecycle: "ready",
    ...overrides,
  };
}

const sessionMethods = {
  async startRun() {},
  async steer() {},
  async cancel() {},
  async exposePort(guestPort: number, protocol: "http" | "https" | "tcp" = "http") {
    return {
      guestPort,
      host: "127.0.0.1" as const,
      hostPort: guestPort,
      protocol,
      url: `${protocol}://127.0.0.1:${String(guestPort)}/`,
    };
  },
};

describe("createRuntimeSupervisor", () => {
  test("does not start when explicit container selection is unavailable", async () => {
    let starts = 0;
    const backend: RuntimeBackend = {
      async inspect() {
        return { available: false, reason: "engine_missing", message: "install Podman" };
      },
      async start() {
        starts += 1;
        return { info: info(), ...sessionMethods, async stop() {} };
      },
    };
    await expect(createRuntimeSupervisor(backend).launch(spec)).rejects.toMatchObject({
      code: "engine_missing",
    });
    expect(starts).toBe(0);
  });

  test("stops a mismatched guest before rejecting its handshake", async () => {
    let stops = 0;
    const backend: RuntimeBackend = {
      async inspect() {
        return { available: true, engineVersion: "5.0.0", rootless: true };
      },
      async start() {
        return {
          info: info({ generation: "forged" }),
          ...sessionMethods,
          async stop() {
            stops += 1;
          },
        };
      },
    };
    await expect(createRuntimeSupervisor(backend).launch(spec)).rejects.toMatchObject({
      code: "handshake_mismatch",
    });
    expect(stops).toBe(1);
  });

  test("admits one generation, rejects overlap, and makes stop idempotent", async () => {
    let stops = 0;
    const backend: RuntimeBackend = {
      async inspect() {
        return { available: true, engineVersion: "5.0.0", rootless: true };
      },
      async start() {
        return {
          info: info(),
          ...sessionMethods,
          async stop() {
            stops += 1;
          },
        };
      },
    };
    const supervisor = createRuntimeSupervisor(backend);
    const session = await supervisor.launch(spec);
    await expect(supervisor.launch(spec)).rejects.toBeInstanceOf(RuntimeLaunchError);
    await expect(session.exposePort(9090)).resolves.toMatchObject({
      guestPort: 9090,
      hostPort: 9090,
    });
    await session.stop();
    await session.stop();
    expect(stops).toBe(1);
  });
});
