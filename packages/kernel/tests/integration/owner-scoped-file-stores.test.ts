import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "bun:test";
import { ownerSegment, workspaceStatePaths } from "@clarvis/paths";
import { createOwnerScopedFileStores } from "../../src/bootstrap.ts";

describe("createOwnerScopedFileStores", () => {
  it("keeps owners' plan repositories separate", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "clarvis-scope-"));
    const stores = createOwnerScopedFileStores({ workspaceRoot });
    const created = await stores.planStoreFor("alice").create({
      title: "Hers",
      objective: "o",
      tasks: [{ title: "t" }],
      createdByRun: "run-1",
    });

    expect(created.path).toBe(
      `.clarvis/owners/alice/plans/${created.path?.split("/").pop() ?? ""}`,
    );
    expect((await stores.planStoreFor("alice").list()).plans).toHaveLength(1);
    expect((await stores.planStoreFor("bob").list()).plans).toHaveLength(0);
    await expect(stores.planStoreFor("bob").read(created.id)).rejects.toThrow(/not found/i);
  });

  it("keeps owners' memory trees separate", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "clarvis-scope-"));
    const stores = createOwnerScopedFileStores({ workspaceRoot });

    await stores.memoryStoreFor("alice").exclusive(async (tx) => {
      await tx.write("PROFILE.md", "---\ndescription: alice\n---\n\nhers\n");
    });

    expect(await stores.memoryStoreFor("bob").exclusive((tx) => tx.list())).toEqual([]);
    expect(
      existsSync(join(workspaceRoot, ".clarvis", "owners", "alice", "memory", "PROFILE.md")),
    ).toBe(true);
    expect(
      existsSync(join(workspaceRoot, ".clarvis", "owners", "bob", "memory", "PROFILE.md")),
    ).toBe(false);
  });

  it("memoizes resident stores and releases only the evicted owner", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "clarvis-scope-"));
    const stores = createOwnerScopedFileStores({ workspaceRoot });
    const alicePlan = stores.planStoreFor("alice");
    const aliceMemory = stores.memoryStoreFor("alice");
    const bobPlan = stores.planStoreFor("bob");
    const bobMemory = stores.memoryStoreFor("bob");

    expect(stores.planStoreFor("alice")).toBe(alicePlan);
    expect(stores.memoryStoreFor("alice")).toBe(aliceMemory);
    expect(alicePlan).not.toBe(bobPlan);
    expect(aliceMemory).not.toBe(bobMemory);

    stores.evictOwner("alice");

    expect(stores.planStoreFor("alice")).not.toBe(alicePlan);
    expect(stores.memoryStoreFor("alice")).not.toBe(aliceMemory);
    expect(stores.planStoreFor("bob")).toBe(bobPlan);
    expect(stores.memoryStoreFor("bob")).toBe(bobMemory);
  });

  it("preserves owner content and machinery roots", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "clarvis-scope-"));
    const stores = createOwnerScopedFileStores({ workspaceRoot });
    const segment = ownerSegment("alice");
    const state = workspaceStatePaths(workspaceRoot);

    await stores.planStoreFor("alice").create({
      title: "Plan",
      objective: "o",
      tasks: [{ title: "t" }],
      createdByRun: "run-1",
    });
    await stores.memoryStoreFor("alice").exclusive((tx) => tx.list());

    expect(existsSync(join(workspaceRoot, ".clarvis", "owners", segment, "plans"))).toBe(true);
    expect(existsSync(join(workspaceRoot, ".clarvis", "owners", segment, "memory"))).toBe(true);
    expect(existsSync(state.plansLockDirForOwner("alice"))).toBe(true);
    expect(existsSync(state.memoryMachineryRootForOwner("alice"))).toBe(true);
  });

  it("encodes an owner id that would otherwise escape its directory", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "clarvis-scope-"));
    const stores = createOwnerScopedFileStores({ workspaceRoot });
    const owner = "../escape";
    const created = await stores.planStoreFor(owner).create({
      title: "Contained",
      objective: "o",
      tasks: [{ title: "t" }],
      createdByRun: "run-1",
    });

    expect(ownerSegment(owner)).not.toContain("/");
    expect(basename(join(workspaceRoot, "..", "escape"))).toBe("escape");
    expect(existsSync(join(workspaceRoot, "..", "escape"))).toBe(false);
    expect(created.path).toContain(`/owners/${ownerSegment(owner)}/plans/`);
  });
});
