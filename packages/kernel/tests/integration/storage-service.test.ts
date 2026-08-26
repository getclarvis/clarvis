import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { globalPaths, HOME_ENV, workspaceStatePaths } from "@clarvis/paths";
import { createStorageService } from "../../src/storage/storage-service.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("StorageService", () => {
  let dir: string;
  let workspace: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clarvis-storage-"));
    workspace = mkdtempSync(join(tmpdir(), "clarvis-storage-workspace-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("reports category metadata without credential sizes or contents", async () => {
    const paths = globalPaths(dir);
    const state = workspaceStatePaths(workspace, { env: { [HOME_ENV]: dir } });
    mkdirSync(paths.tracesDir, { recursive: true });
    mkdirSync(state.localDir, { recursive: true });
    writeFileSync(join(paths.tracesDir, "trace.json"), "x".repeat(20));
    writeFileSync(state.toolOutputSpill("fresh"), "y".repeat(30), { mode: 0o644 });
    writeFileSync(paths.subscriptionsFile, "secret", { mode: 0o600 });

    const snapshot = await createStorageService(dir).inspect();

    expect(snapshot.categories.find((row) => row.category === "traces")?.bytes).toBe(20);
    expect(snapshot.categories.find((row) => row.category === "spills")?.bytes).toBe(30);
    expect(snapshot.credentials.subscriptions).toEqual({
      present: true,
      owner_only: process.platform === "win32" ? null : true,
    });
    expect(JSON.stringify(snapshot.credentials)).not.toContain("secret");
    expect(Object.hasOwn(snapshot.credentials.subscriptions, "bytes")).toBe(false);
  });

  it("previews and applies only stale temporary artifacts and disposable cache", async () => {
    const paths = globalPaths(dir);
    const state = workspaceStatePaths(workspace, { env: { [HOME_ENV]: dir } });
    mkdirSync(state.localDir, { recursive: true });
    mkdirSync(paths.cache, { recursive: true });
    const stale = state.spillFile("stale", "stdout");
    const fresh = state.spillFile("fresh", "stderr");
    writeFileSync(stale, "old");
    writeFileSync(fresh, "new");
    writeFileSync(paths.modelsCacheFile, "cache");
    const stamp = new Date(Date.now() - 2 * DAY_MS);
    utimesSync(stale, stamp, stamp);
    const service = createStorageService(dir);

    const preview = await service.cleanup({ categories: ["temporary", "cache"], dry_run: true });
    expect(preview.reclaimable_bytes).toBe(Buffer.byteLength("oldcache"));
    expect(preview.after).toBeUndefined();

    const applied = await service.cleanup({ categories: ["temporary", "cache"], dry_run: false });
    expect(applied.removed_bytes).toBe(Buffer.byteLength("oldcache"));
    expect(applied.after?.categories.find((row) => row.category === "spills")?.bytes).toBe(
      Buffer.byteLength("new"),
    );
    expect(applied.after?.categories.find((row) => row.category === "cache")?.bytes).toBe(0);
  });

  it("rejects an empty or unknown cleanup category set", async () => {
    const service = createStorageService(dir);
    await expect(service.cleanup({ categories: [], dry_run: true })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      service.cleanup({ categories: ["traces" as never], dry_run: true }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("refuses destructive cleanup when its inventory is incomplete", async () => {
    const paths = globalPaths(dir);
    mkdirSync(paths.cache, { recursive: true });
    writeFileSync(join(paths.cache, "first"), "one");
    writeFileSync(join(paths.cache, "second"), "two");
    const service = createStorageService(dir, { maxEntries: 1 });

    const preview = await service.cleanup({ categories: ["cache"], dry_run: true });
    expect(preview.before.truncated).toBe(true);
    await expect(service.cleanup({ categories: ["cache"], dry_run: false })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(existsSync(join(paths.cache, "first"))).toBe(true);
    expect(existsSync(join(paths.cache, "second"))).toBe(true);
  });
});
