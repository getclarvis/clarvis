import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envSchema } from "@clarvis/capability";
import * as loopHost from "@clarvis/loop/host";
import { WorkspaceHousekeeping } from "../../src/application/workspace-housekeeping.ts";
import { createContainerNativeKernel } from "../../src/hosting/container-native.ts";
import { projectContainerConfiguration } from "../../src/config/container-projection.ts";

test("native close drains every resource despite a collector failure and retries only failed disposal", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-native-close-"));
  const workspaceRoot = join(root, "workspace");
  const globalDir = join(root, "state");
  mkdirSync(workspaceRoot);
  mkdirSync(globalDir);
  const originalBuild = loopHost.buildExecuteRunDeps;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with its original instance via .call below.
  const originalStop = WorkspaceHousekeeping.prototype.stop;
  let disposed = 0;
  let attempts = 0;
  const build = spyOn(loopHost, "buildExecuteRunDeps").mockImplementation(async (options) => {
    const built = await originalBuild(options);
    return {
      ...built,
      dispose: async () => {
        disposed++;
        await built.dispose();
      },
    };
  });
  const stop = spyOn(WorkspaceHousekeeping.prototype, "stop").mockImplementation(async function (
    this: WorkspaceHousekeeping,
  ) {
    await originalStop.call(this);
    if (++attempts === 1) throw new Error("fixture collector disposal failure");
  });
  let graph: Awaited<ReturnType<typeof createContainerNativeKernel>> | undefined;
  try {
    graph = await createContainerNativeKernel({
      configuration: projectContainerConfiguration({
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
      }),
      globalDir,
      owner: "fixture",
      project: { id: "project" },
      workspace: {
        id: "workspace",
        projectId: "project",
        label: "fixture",
        kind: "primary",
        path: workspaceRoot,
      },
      runtime: {
        kind: "container",
        engine: "podman",
        host_platform: "linux",
        guest_platform: "linux",
        network: "none",
        lifecycle: "starting",
      },
      llm: {
        call: async () => {
          throw new Error("unexpected inference");
        },
      },
    });
    await expect(graph.kernel.close()).rejects.toThrow("resources failed to close");
    expect(graph.kernel.lifecycle.state).toBe("closing");
    expect(disposed).toBe(1);
    await graph.kernel.close();
    expect(graph.kernel.lifecycle.state).toBe("closed");
    expect(attempts).toBe(2);
    expect(disposed).toBe(1);
    await graph.kernel.close();
    expect(attempts).toBe(2);
  } finally {
    try {
      await graph?.kernel.close();
    } finally {
      build.mockRestore();
      stop.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
