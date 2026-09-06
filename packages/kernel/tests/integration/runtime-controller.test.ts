import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME_ENV } from "@clarvis/paths";
import {
  launchIsolatedRuntime,
  loadRuntimeWorkspace,
  type RuntimeBackend,
  type RuntimeInfo,
} from "../../src/index.ts";

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("isolated runtime controller", () => {
  it("prepares before start, activates, and preserves the copy on stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-controller-"));
    cleanup.push(root);
    const workspaceRoot = join(root, "workspace");
    await Bun.write(join(workspaceRoot, "dirty.txt"), "dirty bytes");
    const roots = { env: { [HOME_ENV]: join(root, "home") } };
    let retained = "";
    let stops = 0;
    const backend: RuntimeBackend = {
      async inspect() {
        return { available: true, engineVersion: "5", rootless: true };
      },
      async start(spec) {
        retained = spec.retainedWorkspaceRoot;
        const info: RuntimeInfo = {
          kind: "container",
          generation: spec.generation,
          engine: "podman",
          engineVersion: "5",
          hostPlatform: "linux",
          guestPlatform: "linux",
          imageDigest: spec.imageDigest,
          runtimeProtocolRevision: "2",
          network: spec.network,
          limits: spec.limits,
          lifecycle: "ready",
        };
        return {
          info,
          async startRun() {},
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
    const controller = await launchIsolatedRuntime({
      settings: {
        backend: "podman",
        image_digest: `sha256:${"a".repeat(64)}`,
        network: "none",
        executable: "/usr/bin/podman",
        connection: "local",
        limits: {
          cpu_count: 1,
          memory_bytes: 1024,
          process_count: 8,
          output_bytes: 1024,
          storage_bytes: 2048,
        },
      },
      generation: "generation-1",
      ownerId: "owner-1",
      project: { id: "project-1" },
      workspace: { id: "workspace-1", projectId: "project-1", label: "workspace", kind: "primary" },
      workspaceRoot,
      configurationRevision: "config-1",
      extensionRevision: "extensions-1",
      capabilityMethods: ["memory.read"],
      backend,
      roots,
    });
    expect((await loadRuntimeWorkspace(workspaceRoot, "generation-1", roots)).record.state).toBe(
      "active",
    );
    expect(await Bun.file(join(retained, "dirty.txt")).text()).toBe("dirty bytes");
    await controller.close();
    expect(stops).toBe(1);
    expect((await loadRuntimeWorkspace(workspaceRoot, "generation-1", roots)).record.state).toBe(
      "stopped",
    );
  });

  it("records failed launch and cleanup-pending stop without deleting the copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-controller-failure-"));
    cleanup.push(root);
    const workspaceRoot = join(root, "workspace");
    await Bun.write(join(workspaceRoot, "file.txt"), "bytes");
    const roots = { env: { [HOME_ENV]: join(root, "home") } };
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
      ownerId: "owner-1",
      project: { id: "project-1" },
      workspace: {
        id: "workspace-1",
        projectId: "project-1",
        label: "workspace",
        kind: "primary" as const,
      },
      workspaceRoot,
      configurationRevision: "config-1",
      extensionRevision: "extensions-1",
      capabilityMethods: [] as string[],
      roots,
    };
    await expect(
      launchIsolatedRuntime({
        ...common,
        generation: "failed-generation",
        backend: {
          inspect: async () => ({ available: true, engineVersion: "5", rootless: true }),
          start: async () => Promise.reject(new Error("start failed")),
        },
      }),
    ).rejects.toThrow("start failed");
    expect(
      (await loadRuntimeWorkspace(workspaceRoot, "failed-generation", roots)).record.state,
    ).toBe("failed");

    const controller = await launchIsolatedRuntime({
      ...common,
      generation: "cleanup-generation",
      backend: {
        inspect: async () => ({ available: true, engineVersion: "5", rootless: true }),
        async start(spec) {
          return {
            info: {
              kind: "container",
              generation: spec.generation,
              engine: "podman",
              engineVersion: "5",
              hostPlatform: "linux",
              guestPlatform: "linux",
              imageDigest: spec.imageDigest,
              runtimeProtocolRevision: "2",
              network: spec.network,
              limits: spec.limits,
              lifecycle: "ready",
            },
            async startRun() {},
            async steer() {},
            async cancel() {},
            async exposePort() {
              throw new Error("not exercised");
            },
            async stop() {
              throw new Error("stop failed");
            },
          };
        },
      },
    });
    await expect(controller.close()).rejects.toThrow("stop failed");
    expect(
      (await loadRuntimeWorkspace(workspaceRoot, "cleanup-generation", roots)).record.state,
    ).toBe("cleanup_pending");
    await controller.close();
  });
});
