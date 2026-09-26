import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { createMemoryConfigStore } from "../../src/config/memory-config-store.ts";
import {
  createIsolationService,
  executeWithIsolationBinding,
} from "../../src/execution/isolation-service.ts";

test("run bindings retain global preference and separate owners", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-isolation-run-"));
  const homeRoot = join(root, "home");
  const workspaceRoot = join(root, "workspace");
  const globalRoot = join(homeRoot, ".clarvis");
  const scratchRoot = join(root, "scratch");
  for (const path of [homeRoot, workspaceRoot, globalRoot, scratchRoot]) mkdirSync(path);
  const store = createMemoryConfigStore({
    settings: {
      global: {
        isolation: { mode: "sandbox", workspace: "read-only", network: "disabled" },
      },
    },
  });
  const service = createIsolationService({ store, homeRoot, workspaceRoot, globalRoot });
  const context = (owner: string, executionId: string) =>
    ({ owner, executionId }) as Parameters<typeof service.resolveExecution>[0];

  service.bind("owner-a", "run");
  store.writeSettings("global", { isolation: { mode: "host" } });
  service.bind("owner-b", "run");
  service.inherit("owner-a", "run", "leader");
  const original = await service.resolveExecution(context("owner-a", "run"), scratchRoot);
  const leader = await service.resolveExecution(context("owner-a", "leader"), scratchRoot);
  const next = await service.resolveExecution(context("owner-b", "run"), scratchRoot);
  expect(original.executionPolicy).toMatchObject({
    mode: "sandbox",
    workspaceAccess: "read-only",
    network: "disabled",
  });
  expect(original.executionPolicy?.installationRoots).toContain(
    dirname(realpathSync(process.execPath)),
  );
  expect(leader.executionPolicy).toMatchObject({
    mode: "sandbox",
    workspaceAccess: "read-only",
    network: "disabled",
  });
  expect(next.executionPolicy).toBeUndefined();
  const observe = original.executionPort as unknown as {
    onAvailability?: (ready: boolean) => void;
  };
  observe.onAvailability?.(true);
  store.writeSettings("global", {
    isolation: { mode: "host", network: "enabled" },
  });
  expect(service.availability()).toBe("unverified");
  store.writeSettings("global", {
    isolation: { mode: "sandbox", network: "disabled" },
  });
  expect(service.availability()).toBe("available");
  service.release("owner-a", "run");
  await expect(service.resolveExecution(context("owner-a", "run"), scratchRoot)).rejects.toThrow(
    "binding is missing",
  );
  service.release("owner-a", "leader");
  service.release("owner-b", "run");
});

test("internal runs bind the owner and release the identity after execution", async () => {
  const active = new Set<string>();
  const service = {
    bind(owner: string, id: string) {
      active.add(`${owner}:${id}`);
    },
    release(owner: string, id: string) {
      active.delete(`${owner}:${id}`);
    },
  } as Parameters<typeof executeWithIsolationBinding>[0];
  const args = {
    owner: "goal-owner",
    rawBody: { execution_id: "goal-run" },
  } as Parameters<typeof executeWithIsolationBinding>[1];
  await expect(
    executeWithIsolationBinding(service, args, async () => {
      expect(active.has("goal-owner:goal-run")).toBe(true);
      throw new Error("run failed");
    }),
  ).rejects.toThrow("run failed");
  expect(active.size).toBe(0);
  await expect(
    executeWithIsolationBinding(service, { ...args, rawBody: {} }, async () => {
      throw new Error("must not execute");
    }),
  ).rejects.toThrow("requires an execution id");
  expect(active.size).toBe(0);
});
