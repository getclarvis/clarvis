import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  allocateShortTemporaryRoot,
  collectAbandonedShortTemporaryRoots,
  shortTemporaryRootCandidates,
  sweepGlobalStateArtifacts,
  type ShortTemporaryRootOptions,
} from "@clarvis/paths";

import { recorder } from "../helpers/recorder.ts";

const roots: string[] = [];

/** Directory modes and symlink creation express privacy on POSIX only. */
const windows = process.platform === "win32";

function ownedRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** One allocation under a test-owned base; the base is long, so the budget is raised. */
function allocate(
  base: string,
  label = "run",
  identity = "exec_test",
  extra: Partial<ShortTemporaryRootOptions> = {},
) {
  const log = recorder();
  const allocation = allocateShortTemporaryRoot({
    label,
    identity,
    candidates: [base],
    budgetBytes: 4096,
    requireTrustedAncestors: false,
    logger: log.logger,
    ...extra,
  });
  return { allocation, log, container: dirname(dirname(allocation.path)) };
}

/** The options one allocation of a test-owned base needs, for a negative case. */
function request(base: string, extra: Partial<ShortTemporaryRootOptions> = {}) {
  return {
    label: "run",
    identity: "exec_test",
    candidates: [base],
    budgetBytes: 4096,
    requireTrustedAncestors: false,
    logger: recorder().logger,
    ...extra,
  };
}

/** Write an allocation directory plus its metadata record by hand. */
function plant(
  container: string,
  id: string,
  record: Record<string, unknown>,
  content?: string,
): string {
  const directory = join(container, "r", id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (content !== undefined) writeFileSync(join(directory, content), "content");
  writeFileSync(join(container, "a", `${id}.json`), JSON.stringify(record));
  return directory;
}

const record = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 1,
  id,
  label: "run",
  pid: 4242,
  host: hostname(),
  created_at: 0,
  ...overrides,
});

describe("short temporary allocation", () => {
  test("creates an exclusive owner-only scratch, records it, and removes exactly it", () => {
    const base = ownedRoot("clarvis-short-alloc-");
    const { allocation, log, container } = allocate(base, "run", "exec_abc");
    expect(existsSync(allocation.path)).toBe(true);
    expect(allocation.path.startsWith(base)).toBe(true);
    expect(basename(dirname(allocation.path))).toBe("r");
    expect(allocation.id).toMatch(/^[A-Za-z0-9_-]{8}$/);
    if (!windows) expect(statSync(allocation.path).mode & 0o777).toBe(0o700);
    expect(statSync(allocation.path).isDirectory()).toBe(true);

    const metadata = JSON.parse(
      readFileSync(join(container, "a", `${allocation.id}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      schema: 1,
      id: allocation.id,
      label: "run",
      identity: "exec_abc",
      pid: process.pid,
      host: hostname(),
    });
    expect(typeof metadata.created_at).toBe("number");
    expect(log.events("paths.temporary_root_allocated")).toMatchObject([{ label: "run" }]);

    allocation.remove();
    expect(existsSync(allocation.path)).toBe(false);
    expect(existsSync(join(container, "a", `${allocation.id}.json`))).toBe(false);
    allocation.remove();
    expect(log.events("paths.temporary_root_cleanup_failed")).toEqual([]);
    expect(existsSync(container)).toBe(true);
  });

  test("gives two runs of one account their own scratch", () => {
    const base = ownedRoot("clarvis-short-many-");
    const first = allocate(base, "run", "exec_first");
    const second = allocate(base, "smoke", "exec_second");
    expect(first.allocation.path).not.toBe(second.allocation.path);
    expect(existsSync(first.allocation.path)).toBe(true);
    expect(existsSync(second.allocation.path)).toBe(true);
    first.allocation.remove();
    expect(existsSync(first.allocation.path)).toBe(false);
    expect(existsSync(second.allocation.path)).toBe(true);
    second.allocation.remove();
  });

  test.skipIf(windows)(
    "refuses an existing container it cannot call its own, and never repairs it",
    () => {
      const base = ownedRoot("clarvis-short-container-");
      const { container } = allocate(base);
      chmodSync(container, 0o755);
      const log = recorder();
      expect(() =>
        allocateShortTemporaryRoot({
          label: "run",
          candidates: [base],
          budgetBytes: 4096,
          requireTrustedAncestors: false,
          logger: log.logger,
        }),
      ).toThrow("short_temporary_root_unavailable");
      expect(statSync(container).mode & 0o777).toBe(0o755);
      expect(log.events("paths.temporary_root_allocation_failed")).toMatchObject([
        { reason: "unusable" },
      ]);
    },
  );

  test("orders a fitting base first and refuses an unfitting one only on request", () => {
    const base = ownedRoot("clarvis-short-budget-");
    const deeper = join(base, "x".repeat(40));
    mkdirSync(deeper, { mode: 0o700 });
    const { allocation } = allocate(base);
    const budget = Buffer.byteLength(allocation.path, "utf8");
    const order = {
      candidates: [deeper, base],
      requireTrustedAncestors: false,
      budgetBytes: budget,
    };
    expect(shortTemporaryRootCandidates(order)).toEqual([base, deeper]);
    expect(shortTemporaryRootCandidates({ ...order, requireBudget: true })).toEqual([base]);
  });
});

describe("short temporary allocation failures", () => {
  test("draws a new id when one is taken, and gives up only after its bounded attempts", () => {
    const base = ownedRoot("clarvis-short-collision-");
    const { container } = allocate(base);
    mkdirSync(join(container, "r", "taken"), { mode: 0o700 });
    const drawn = ["taken", "fresh"];
    const retried = allocate(base, "run", "exec_retry", {
      nextId: () => drawn.shift() ?? "fresh",
    });
    expect(retried.allocation.id).toBe("fresh");
    expect(existsSync(retried.allocation.path)).toBe(true);

    const log = recorder();
    expect(() =>
      allocateShortTemporaryRoot({ ...request(base), nextId: () => "taken", logger: log.logger }),
    ).toThrow("short_temporary_root_unavailable");
    expect(log.events("paths.temporary_root_allocation_failed")).toMatchObject([
      { reason: "collision" },
    ]);
  });

  test("rejects a candidate whose allocation cannot be created at all", () => {
    const base = ownedRoot("clarvis-short-unusable-");
    const log = recorder();
    expect(() =>
      allocateShortTemporaryRoot({
        ...request(base),
        nextId: () => "nested/path",
        logger: log.logger,
      }),
    ).toThrow("short_temporary_root_unavailable");
    expect(log.events("paths.temporary_root_allocation_failed")).toMatchObject([
      { reason: "unusable", code: "ENOENT" },
    ]);
  });

  test("removes an allocation whose recovery metadata cannot be published", () => {
    const base = ownedRoot("clarvis-short-metadata-");
    const { container } = allocate(base);
    writeFileSync(join(container, "a", "taken.json"), "already here");
    const log = recorder();
    expect(() =>
      allocateShortTemporaryRoot({ ...request(base), nextId: () => "taken", logger: log.logger }),
    ).toThrow("short_temporary_root_unavailable");
    expect(log.events("paths.temporary_root_allocation_failed")).toMatchObject([
      { reason: "metadata", code: "EEXIST" },
    ]);
    expect(existsSync(join(container, "r", "taken"))).toBe(false);
    expect(readFileSync(join(container, "a", "taken.json"), "utf8")).toBe("already here");
  });

  test("refuses a container subtree that is not its own", () => {
    const base = ownedRoot("clarvis-short-subtree-");
    const { container } = allocate(base);
    rmSync(join(container, "a"), { recursive: true, force: true });
    writeFileSync(join(container, "a"), "not a directory");
    expect(() => allocateShortTemporaryRoot(request(base))).toThrow(
      "short_temporary_root_unavailable",
    );
  });

  test.skipIf(windows)("refuses a base that cannot host the container", () => {
    const base = ownedRoot("clarvis-short-readonly-");
    chmodSync(base, 0o500);
    try {
      expect(() => allocateShortTemporaryRoot(request(base))).toThrow(
        "short_temporary_root_unavailable",
      );
    } finally {
      chmodSync(base, 0o700);
    }
  });

  test.skipIf(windows)(
    "leaves an allocation that no longer has its identity, and its record",
    () => {
      const base = ownedRoot("clarvis-short-identity-");
      const { allocation, log, container } = allocate(base);
      rmSync(allocation.path, { recursive: true, force: true });
      symlinkSync(base, allocation.path);
      allocation.remove();
      expect(log.events("paths.temporary_root_cleanup_failed")).toMatchObject([
        { reason: "identity_changed" },
      ]);
      expect(existsSync(join(container, "a", `${allocation.id}.json`))).toBe(true);
    },
  );

  test("drops the record of an allocation whose directory already vanished", () => {
    const base = ownedRoot("clarvis-short-vanished-");
    const { allocation, log, container } = allocate(base);
    rmSync(allocation.path, { recursive: true, force: true });
    allocation.remove();
    expect(log.events("paths.temporary_root_cleanup_failed")).toEqual([]);
    expect(existsSync(join(container, "a", `${allocation.id}.json`))).toBe(false);
  });

  test.skipIf(windows)("reports a cleanup that could not remove its record", () => {
    const base = ownedRoot("clarvis-short-cleanup-");
    const { allocation, log, container } = allocate(base);
    chmodSync(join(container, "a"), 0o500);
    try {
      allocation.remove();
      expect(existsSync(allocation.path)).toBe(false);
      expect(log.events("paths.temporary_root_cleanup_failed")).toMatchObject([
        { reason: "remove_failed" },
      ]);
    } finally {
      chmodSync(join(container, "a"), 0o700);
    }
  });

  test("uses a same-host liveness probe when none is injected", async () => {
    const base = ownedRoot("clarvis-short-liveness-");
    const { container } = allocate(base);
    const live = plant(container, "live", record("live", { pid: process.pid }));
    const nonsense = plant(container, "nonsense", record("nonsense", { pid: -1 }));
    const gone = plant(container, "gone", record("gone", { pid: 10_000_000 }));
    const report = await collectAbandonedShortTemporaryRoots({
      candidates: [base],
      budgetBytes: 4096,
      requireTrustedAncestors: false,
      graceMs: 0,
      logger: recorder().logger,
    });
    expect(report.removed).toBe(1);
    expect(report.preservedActive).toBe(3);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(nonsense)).toBe(true);
    expect(existsSync(gone)).toBe(false);
  });

  test.skipIf(windows)(
    "preserves an abandoned allocation whose contents it cannot read",
    async () => {
      const base = ownedRoot("clarvis-short-unreadable-");
      const { container } = allocate(base);
      const kept = plant(container, "unreadable", record("unreadable"));
      chmodSync(kept, 0o000);
      try {
        const report = await collectAbandonedShortTemporaryRoots({
          candidates: [base],
          budgetBytes: 4096,
          requireTrustedAncestors: false,
          graceMs: 0,
          isProcessAlive: (pid) => pid === process.pid,
          logger: recorder().logger,
        });
        expect(report.removed).toBe(0);
        expect(report.preservedContent).toBe(1);
        expect(existsSync(kept)).toBe(true);
      } finally {
        chmodSync(kept, 0o700);
      }
    },
  );

  test("counts metadata it does not recognise without touching it", async () => {
    const base = ownedRoot("clarvis-short-notes-");
    const { container } = allocate(base);
    const notes = join(container, "a", "notes.txt");
    writeFileSync(notes, "not metadata");
    const report = await collectAbandonedShortTemporaryRoots({
      candidates: [base],
      budgetBytes: 4096,
      requireTrustedAncestors: false,
      isProcessAlive: () => false,
      logger: recorder().logger,
    });
    expect(report.preservedUnverified).toBe(1);
    expect(existsSync(notes)).toBe(true);
  });

  test.skipIf(windows)("keeps the record when the removal itself fails", async () => {
    const base = ownedRoot("clarvis-short-sweep-failure-");
    const { container } = allocate(base);
    const directory = plant(container, "stuck", record("stuck"));
    chmodSync(join(container, "a"), 0o500);
    try {
      const report = await collectAbandonedShortTemporaryRoots({
        candidates: [base],
        budgetBytes: 4096,
        requireTrustedAncestors: false,
        graceMs: 0,
        isProcessAlive: () => false,
        logger: recorder().logger,
      });
      expect(report.removed).toBe(0);
      expect(report.preservedUnverified).toBeGreaterThan(0);
      expect(existsSync(join(container, "a", "stuck.json"))).toBe(true);
      expect(existsSync(directory)).toBe(false);
    } finally {
      chmodSync(join(container, "a"), 0o700);
    }
  });
});

describe("abandoned short temporary roots", () => {
  test("removes only provably dead and empty allocations", async () => {
    const base = ownedRoot("clarvis-short-sweep-");
    const { allocation, container } = allocate(base);
    const empty = plant(container, "deadempty", record("deadempty"));
    const occupied = plant(container, "deadcontent", record("deadcontent"), "artifact.txt");
    const foreignHost = plant(
      container,
      "foreignhost",
      record("foreignhost", { host: "elsewhere" }),
    );
    const recent = plant(container, "recent", record("recent", { created_at: Date.now() }));
    const malformed = join(container, "a", "malformed.json");
    writeFileSync(malformed, "{ not json");
    const orphan = join(container, "r", "orphan");
    mkdirSync(orphan, { mode: 0o700 });

    const report = await collectAbandonedShortTemporaryRoots({
      candidates: [base],
      budgetBytes: 4096,
      requireTrustedAncestors: false,
      graceMs: 60_000,
      isProcessAlive: (pid) => pid === process.pid,
      logger: recorder().logger,
    });

    expect(report.containers).toBe(1);
    expect(report.removed).toBe(1);
    expect(report.preservedActive).toBe(2);
    expect(report.preservedContent).toBe(1);
    expect(report.preservedUnverified).toBe(3);
    expect(report.truncated).toBe(false);
    expect(existsSync(empty)).toBe(false);
    expect(existsSync(join(container, "a", "deadempty.json"))).toBe(false);
    for (const kept of [allocation.path, occupied, foreignHost, recent, orphan])
      expect(existsSync(kept)).toBe(true);
    expect(existsSync(malformed)).toBe(true);
  });

  test("drops a record whose allocation is already gone", async () => {
    const base = ownedRoot("clarvis-short-stale-");
    const { allocation, container } = allocate(base);
    const recordFile = join(container, "a", "vanished.json");
    writeFileSync(recordFile, JSON.stringify(record("vanished")));
    const report = await collectAbandonedShortTemporaryRoots({
      candidates: [base],
      budgetBytes: 4096,
      requireTrustedAncestors: false,
      graceMs: 0,
      isProcessAlive: (pid) => pid === process.pid,
      logger: recorder().logger,
    });
    expect(report.removed).toBe(0);
    expect(report.preservedActive).toBe(1);
    expect(existsSync(allocation.path)).toBe(true);
    expect(existsSync(recordFile)).toBe(false);
  });

  test("bounds one pass and reports truncation", async () => {
    const base = ownedRoot("clarvis-short-bound-");
    const { container } = allocate(base);
    plant(container, "deadempty", record("deadempty"));
    const report = await collectAbandonedShortTemporaryRoots({
      candidates: [base],
      budgetBytes: 4096,
      requireTrustedAncestors: false,
      graceMs: 0,
      maxEntries: 0,
      isProcessAlive: () => false,
      logger: recorder().logger,
    });
    expect(report.truncated).toBe(true);
    expect(report.removed).toBe(0);
  });

  test.skipIf(windows)("survives a stale record it cannot drop", async () => {
    const base = ownedRoot("clarvis-short-stale-stuck-");
    const { container } = allocate(base);
    const recordFile = join(container, "a", "vanished.json");
    writeFileSync(recordFile, JSON.stringify(record("vanished")));
    chmodSync(join(container, "a"), 0o500);
    try {
      const report = await collectAbandonedShortTemporaryRoots({
        candidates: [base],
        budgetBytes: 4096,
        requireTrustedAncestors: false,
        isProcessAlive: () => false,
        logger: recorder().logger,
      });
      expect(report.removed).toBe(0);
      expect(existsSync(recordFile)).toBe(true);
    } finally {
      chmodSync(join(container, "a"), 0o700);
    }
  });

  test("the global sweep folds the platform pass in, and can be scoped out", async () => {
    const base = ownedRoot("clarvis-short-global-");
    const { container } = allocate(base);
    plant(container, "deadempty", record("deadempty"));
    const global = ownedRoot("clarvis-short-global-state-");
    const scoped = await sweepGlobalStateArtifacts(global, {
      temporaryRoots: {
        candidates: [base],
        budgetBytes: 4096,
        requireTrustedAncestors: false,
        graceMs: 0,
        isProcessAlive: (pid) => pid === process.pid,
      },
    });
    expect(scoped.temporaryRootsRemoved).toBe(1);

    plant(container, "deadempty2", record("deadempty2"));
    const skipped = await sweepGlobalStateArtifacts(global, { temporaryRoots: false });
    expect(skipped.temporaryRootsRemoved).toBe(0);
    expect(existsSync(join(container, "r", "deadempty2"))).toBe(true);
  });
});
