import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME_ENV, workspaceStatePaths } from "@clarvis/paths";
import {
  appendRuntimeCheckpoint,
  loadRuntimeCheckpoint,
  settleRuntimeTerminal,
} from "../../src/index.ts";

const directories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-checkpoint-"));
  directories.push(root);
  const workspace = join(root, "workspace");
  const roots = { env: { [HOME_ENV]: join(root, "home") } };
  return { workspace, roots };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("runtime checkpoint durability", () => {
  it("persists monotonic bounded reconstruction state", async () => {
    const { workspace, roots } = await fixture();
    await appendRuntimeCheckpoint(
      workspace,
      {
        generation: "generation-1",
        runId: "run-1",
        sequence: 1,
        terminal: false,
        state: { turn: 1 },
      },
      roots,
      () => 100,
    );
    await appendRuntimeCheckpoint(
      workspace,
      {
        generation: "generation-1",
        runId: "run-1",
        sequence: 2,
        terminal: false,
        state: { turn: 2 },
      },
      roots,
      () => 200,
    );
    await expect(
      loadRuntimeCheckpoint(workspace, "generation-1", "run-1", roots),
    ).resolves.toMatchObject({
      sequence: 2,
      state: { turn: 2 },
      acceptedAt: 200,
    });
    await expect(
      appendRuntimeCheckpoint(
        workspace,
        { generation: "generation-1", runId: "run-1", sequence: 4, terminal: false, state: {} },
        roots,
      ),
    ).rejects.toMatchObject({ code: "checkpoint_conflict" });
  });

  it("acknowledges terminal state only after all host durability participants", async () => {
    const { workspace, roots } = await fixture();
    const order: string[] = [];
    const terminal = await settleRuntimeTerminal({
      workspaceRoot: workspace,
      roots,
      checkpoint: {
        generation: "generation-1",
        runId: "run-1",
        sequence: 1,
        terminal: true,
        state: { result: "done" },
      },
      participants: (["session", "trace", "capabilities", "workspace"] as const).map((name) => ({
        name,
        async commit() {
          order.push(name);
        },
      })),
    });
    expect(order).toEqual(["session", "trace", "capabilities", "workspace"]);
    expect(terminal.terminal).toBe(true);
    await expect(
      appendRuntimeCheckpoint(
        workspace,
        { generation: "generation-1", runId: "run-1", sequence: 2, terminal: false, state: {} },
        roots,
      ),
    ).rejects.toMatchObject({ code: "checkpoint_conflict" });
  });

  it("does not publish terminal checkpoint when a participant fails", async () => {
    const { workspace, roots } = await fixture();
    await expect(
      settleRuntimeTerminal({
        workspaceRoot: workspace,
        roots,
        checkpoint: {
          generation: "generation-1",
          runId: "run-1",
          sequence: 1,
          terminal: true,
          state: {},
        },
        participants: (["session", "trace", "capabilities", "workspace"] as const).map((name) => ({
          name,
          async commit() {
            if (name === "trace") throw new Error("fsync failed");
          },
        })),
      }),
    ).rejects.toThrow("fsync failed");
    expect(await loadRuntimeCheckpoint(workspace, "generation-1", "run-1", roots)).toBeNull();
  });

  it("refuses a checkpoint whose persisted identity was tampered", async () => {
    const { workspace, roots } = await fixture();
    const path = workspaceStatePaths(workspace, roots).runtimeCheckpointFile(
      "generation-1",
      "run-1",
    );
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        generation: "forged",
        runId: "run-1",
        sequence: 1,
        terminal: false,
        state: {},
        acceptedAt: 1,
      }),
    );
    await expect(
      loadRuntimeCheckpoint(workspace, "generation-1", "run-1", roots),
    ).rejects.toMatchObject({ code: "checkpoint_corrupt" });
  });
});
