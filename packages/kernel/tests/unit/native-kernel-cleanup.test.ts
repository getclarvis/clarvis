import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envSchema } from "@clarvis/capability";
import * as loopHost from "@clarvis/loop/host";
import { WorkspaceHousekeeping } from "../../src/application/workspace-housekeeping.ts";
import { createFileKernel } from "../../src/file-kernel.ts";

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
  let graph: Awaited<ReturnType<typeof createFileKernel>> | undefined;
  try {
    graph = await createFileKernel({
      workspaceRoot,
      globalDir,
      defaultOwner: "fixture",
      env: envSchema.parse({ CLARVIS_OWNER: "fixture" }),
      subscriptions: false,
    });
    await expect(graph.close()).rejects.toThrow("resources failed to close");
    expect(graph.lifecycle.state).toBe("closing");
    expect(disposed).toBe(1);
    await graph.close();
    expect(graph.lifecycle.state).toBe("closed");
    expect(attempts).toBe(2);
    expect(disposed).toBe(1);
    await graph.close();
    expect(attempts).toBe(2);
  } finally {
    try {
      await graph?.close();
    } finally {
      build.mockRestore();
      stop.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
