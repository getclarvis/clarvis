import { expect, test } from "bun:test";
import type {
  WorkspaceChangeDetail,
  WorkspaceChangeEntry,
  WorkspaceChangesAvailability,
  WorkspaceChangesPage,
  WorkspaceChangesService,
} from "@clarvis/protocol";
import { createWorkspaceChangesController } from "../../src/views/overlays/workspace-changes-controller.ts";

function available(): WorkspaceChangesAvailability {
  return {
    status: "available",
    provider: {
      id: "fake",
      name: "Fake",
      workspace_identity: "workspace",
      default_comparison_id: "all",
      comparisons: [
        { id: "all", label: "All", description: "all" },
        { id: "staged", label: "Staged", description: "staged" },
      ],
      capabilities: { staging: true, renames: false, conflicts: false },
    },
  };
}

function page(items: WorkspaceChangeEntry[]): WorkspaceChangesPage {
  return {
    query_id: "q1",
    comparison_id: "all",
    resolved_base: "HEAD",
    incomplete: false,
    items,
  };
}

function ready(entryId: string, patch: string): WorkspaceChangeDetail {
  return {
    entry_id: entryId,
    query_id: "q1",
    comparison_id: "all",
    resolved_base: "HEAD",
    status: "ready",
    patch,
  };
}

function fakeService(options?: {
  availability?: WorkspaceChangesAvailability;
  items?: WorkspaceChangeEntry[];
  failList?: string;
  failRead?: string;
}): WorkspaceChangesService {
  return {
    availability: async () => options?.availability ?? available(),
    list: async () => {
      if (options?.failList) throw new Error(options.failList);
      return page(options?.items ?? [{ id: "a", new_path: "a.ts", operation: "modified" }]);
    },
    read: async (request) => {
      if (options?.failRead) throw new Error(options.failRead);
      return ready(request.entry_id, "patch");
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("loads availability, inventory and the first file while visible", async () => {
  const controller = createWorkspaceChangesController({
    service: () => fakeService(),
    pollMs: 60_000,
    setIntervalFn: () => 1 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => undefined,
  });
  controller.setVisible(true);
  await settle();
  expect(controller.availability()?.status).toBe("available");
  expect(controller.page()?.items.map((item) => item.id)).toEqual(["a"]);
  expect(controller.selectedId()).toBe("a");
  expect(controller.detail()?.patch).toBe("patch");
  controller.dispose();
});

test("records a list failure instead of a clean empty tree", async () => {
  const controller = createWorkspaceChangesController({
    service: () => fakeService({ failList: "git refused" }),
    pollMs: 60_000,
    setIntervalFn: () => 1 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => undefined,
  });
  controller.setVisible(true);
  await settle();
  expect(controller.error()).toBe("git refused");
  expect(controller.page()).toBeNull();
  controller.dispose();
});

test("cycles comparisons and reloads the selected inventory", async () => {
  const seen: string[] = [];
  const service: WorkspaceChangesService = {
    availability: async () => available(),
    list: async (request) => {
      const comparison = request?.comparison_id ?? "default";
      seen.push(comparison);
      return page([
        {
          id: comparison === "default" ? "all" : comparison,
          new_path: "x.ts",
          operation: "modified",
        },
      ]);
    },
    read: async (request) => ready(request.entry_id, request.comparison_id ?? ""),
  };
  const controller = createWorkspaceChangesController({
    service: () => service,
    pollMs: 60_000,
    setIntervalFn: () => 1 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => undefined,
  });
  controller.setVisible(true);
  await settle();
  controller.cycleComparison(1);
  await settle();
  expect(controller.comparisonId()).toBe("staged");
  expect(seen).toContain("staged");
  controller.dispose();
});

test("selects another file and records a read failure", async () => {
  const controller = createWorkspaceChangesController({
    service: () =>
      fakeService({
        items: [
          { id: "a", new_path: "a.ts", operation: "modified" },
          { id: "b", new_path: "b.ts", operation: "modified" },
        ],
        failRead: "stale inventory",
      }),
    pollMs: 60_000,
    setIntervalFn: () => 1 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => undefined,
  });
  controller.setVisible(true);
  await settle();
  controller.select("b");
  await settle();
  expect(controller.selectedId()).toBe("b");
  expect(controller.error()).toBe("stale inventory");
  controller.dispose();
});

test("hides without polling and formats a non-error throw", async () => {
  const timers: Array<() => void> = [];
  const service: WorkspaceChangesService = {
    availability: async () => available(),
    list: async () => {
      throw 42;
    },
    read: async (request) => ready(request.entry_id, "patch"),
  };
  const controller = createWorkspaceChangesController({
    service: () => service,
    pollMs: 10,
    setIntervalFn: ((handler: Parameters<typeof setInterval>[0]) => {
      timers.push(handler as () => void);
      return 7 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearIntervalFn: () => {
      timers.length = 0;
    },
  });
  controller.setVisible(true);
  await settle();
  expect(controller.error()).toBe("could not load workspace changes");
  controller.setVisible(false);
  expect(timers).toEqual([]);
  controller.refresh();
  controller.dispose();
});

test("reports a missing service, ignores a duplicate comparison, and clears a null selection", async () => {
  let current: WorkspaceChangesService | undefined;
  const controller = createWorkspaceChangesController({
    service: () => current,
    pollMs: 60_000,
    setIntervalFn: () => 1 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => undefined,
  });
  controller.setVisible(true);
  await settle();
  expect(controller.error()).toBe("workspace changes are unavailable");
  current = fakeService();
  controller.refresh();
  await settle();
  const id = controller.comparisonId();
  controller.setComparison(id);
  expect(controller.comparisonId()).toBe(id);
  controller.select(null);
  expect(controller.detail()).toBeNull();
  controller.cycleComparison(1);
  await settle();
  expect(controller.comparisonId()).toBe("staged");
  current = fakeService({
    availability: {
      status: "not_applicable",
      reason: { code: "not_a_repository", message: "no repo" },
    },
  });
  controller.refresh();
  await settle();
  controller.cycleComparison(1);
  expect(controller.availability()?.status).toBe("not_applicable");
  controller.dispose();
});

test("coalesces a refresh that arrives while a load is in flight", async () => {
  let resolveList: ((page: WorkspaceChangesPage) => void) | undefined;
  const service: WorkspaceChangesService = {
    availability: async () => available(),
    list: async () =>
      await new Promise((resolve) => {
        resolveList = resolve;
      }),
    read: async (request) => ready(request.entry_id, "patch"),
  };
  const controller = createWorkspaceChangesController({
    service: () => service,
    pollMs: 60_000,
    setIntervalFn: () => 1 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => undefined,
  });
  controller.setVisible(true);
  await settle();
  controller.refresh();
  resolveList?.(page([{ id: "queued", new_path: "q.ts", operation: "modified" }]));
  await settle();
  await settle();
  expect(controller.page()?.items[0]?.id).toBe("queued");
  controller.dispose();
});
