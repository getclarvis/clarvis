import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOME_ENV, workspaceStatePaths } from "@clarvis/paths";

import {
  loadRuntimeWorkspace,
  prepareRuntimeWorkspace,
  RuntimeStoreError,
} from "../../src/index.ts";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-store-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("runtime retained-state store", () => {
  test("durably prepares, registers and reconstructs a generation", async () => {
    const source = await temporaryRoot();
    const home = await temporaryRoot();
    await writeFile(join(source, "dirty.txt"), "working bytes");
    const roots = { env: { [HOME_ENV]: join(home, "state-home") } };
    const identity = {
      project: { id: "project-1" },
      workspace: {
        id: "workspace-1",
        projectId: "project-1",
        label: "primary",
        kind: "primary" as const,
      },
    };

    const prepared = await prepareRuntimeWorkspace({
      runtimeId: "runtime-1",
      ownerId: "owner-1",
      sourceWorkspaceRoot: source,
      roots,
      now: () => 42,
      ...identity,
    });
    const paths = workspaceStatePaths(source, roots);
    const registry = JSON.parse(await readFile(paths.runtimeRegistryFile, "utf8"));
    const restored = await loadRuntimeWorkspace(source, "runtime-1", roots);

    expect(registry).toEqual({ version: 1, runtimes: ["runtime-1"] });
    expect(prepared.record).toEqual(restored.record);
    expect(restored.baseline.digest).toBe(prepared.baseline.digest);
    expect(restored.record).toMatchObject({ state: "prepared", createdAt: 42, updatedAt: 42 });
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      expect((await stat(paths.runtimeRecordFile("runtime-1"))).mode & 0o777).toBe(0o600);
    }
  });

  test("keeps separate workspace histories even though guests use the same mount path", async () => {
    const home = await temporaryRoot();
    const first = await temporaryRoot();
    const second = await temporaryRoot();
    const roots = { env: { [HOME_ENV]: join(home, "state-home") } };
    await writeFile(join(first, "identity"), "first");
    await writeFile(join(second, "identity"), "second");
    const base = {
      runtimeId: "same-runtime-name",
      ownerId: "owner",
      project: { id: "project" },
      roots,
    };
    const one = await prepareRuntimeWorkspace({
      ...base,
      sourceWorkspaceRoot: first,
      workspace: { id: "one", projectId: "project", label: "one", kind: "primary" },
    });
    const two = await prepareRuntimeWorkspace({
      ...base,
      sourceWorkspaceRoot: second,
      workspace: { id: "two", projectId: "project", label: "two", kind: "primary" },
    });

    expect(one.record.retainedWorkspaceRoot).not.toBe(two.record.retainedWorkspaceRoot);
    expect(one.baseline.digest).not.toBe(two.baseline.digest);
  });

  test("refuses duplicate generations without replacing retained work", async () => {
    const source = await temporaryRoot();
    const home = await temporaryRoot();
    const roots = { env: { [HOME_ENV]: join(home, "state-home") } };
    await writeFile(join(source, "file"), "original");
    const options = {
      runtimeId: "runtime-1",
      ownerId: "owner",
      project: { id: "project" },
      workspace: { id: "workspace", projectId: "project", label: "ws", kind: "primary" as const },
      sourceWorkspaceRoot: source,
      roots,
    };
    const first = await prepareRuntimeWorkspace(options);
    await expect(prepareRuntimeWorkspace(options)).rejects.toBeInstanceOf(RuntimeStoreError);
    expect(await readFile(join(first.record.retainedWorkspaceRoot, "file"), "utf8")).toBe(
      "original",
    );
  });

  test("fails reconstruction on record tampering or prepared-copy drift", async () => {
    const source = await temporaryRoot();
    const home = await temporaryRoot();
    const roots = { env: { [HOME_ENV]: join(home, "state-home") } };
    await writeFile(join(source, "file"), "original");
    const prepared = await prepareRuntimeWorkspace({
      runtimeId: "runtime-1",
      ownerId: "owner",
      project: { id: "project" },
      workspace: { id: "workspace", projectId: "project", label: "ws", kind: "primary" },
      sourceWorkspaceRoot: source,
      roots,
    });
    await writeFile(join(prepared.record.retainedWorkspaceRoot, "file"), "tampered");
    await expect(loadRuntimeWorkspace(source, "runtime-1", roots)).rejects.toMatchObject({
      code: "runtime_corrupt",
    });

    const paths = workspaceStatePaths(source, roots);
    await chmod(paths.runtimeRecordFile("runtime-1"), 0o600);
    await writeFile(paths.runtimeRecordFile("runtime-1"), "not-json");
    await expect(loadRuntimeWorkspace(source, "runtime-1", roots)).rejects.toMatchObject({
      code: "runtime_corrupt",
    });
  });
});
