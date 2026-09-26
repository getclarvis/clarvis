import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, parse, resolve } from "node:path";

import {
  UNIX_SOCKET_PATH_BUDGET_BYTES,
  ancestorTrust,
  shortTemporaryRootCandidates,
  unixSocketPathFits,
} from "@clarvis/paths";

import { recorder } from "../helpers/recorder.ts";

const roots: string[] = [];

function ownedRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("ancestor trust", () => {
  const fsRootOwner = lstatSync(parse(resolve(tmpdir())).root).uid;
  /** A process holding the root account's capabilities is not denied by a mode bit. */
  const runningAsRoot = process.getuid?.() === 0;
  /**
   * A container whose filesystem root belongs to this account cannot present a
   * foreign-owned ancestor at all, so that one verdict is unreachable there.
   */
  const everyAncestorIsOurs = fsRootOwner === process.getuid?.();

  test("names the first offending ancestor", () => {
    const root = ownedRoot("clarvis-trust-");
    writeFileSync(join(root, "not-a-directory"), "x");
    expect(ancestorTrust(join(root, "not-a-directory", "child"))).toEqual({
      trusted: false,
      refusal: "not_a_directory",
      path: join(root, "not-a-directory"),
    });

    symlinkSync(root, join(root, "link"));
    expect(ancestorTrust(join(root, "link", "child"))).toEqual({
      trusted: false,
      refusal: "symlink",
      path: join(root, "link"),
    });

    mkdirSync(join(root, "open"));
    chmodSync(join(root, "open"), 0o777);
    expect(ancestorTrust(join(root, "open", "child"))).toEqual({
      trusted: false,
      refusal: "group_or_world_writable",
      path: join(root, "open"),
    });

    mkdirSync(join(root, "sticky"));
    chmodSync(join(root, "sticky"), 0o1777);
    expect(ancestorTrust(join(root, "sticky", "child")).trusted).toBe(true);
  });

  test.skipIf(runningAsRoot || everyAncestorIsOurs)(
    "refuses an ancestor owned by another account",
    () => {
      const root = ownedRoot("clarvis-trust-owner-");
      expect(ancestorTrust(join(root, "child"), { accountUid: 4242 })).toEqual({
        trusted: false,
        refusal: "foreign_owner",
        path: root,
      });
    },
  );

  test.skipIf(runningAsRoot)("refuses a chain it cannot read", () => {
    const root = ownedRoot("clarvis-trust-unreadable-");
    const closed = join(root, "closed");
    mkdirSync(join(closed, "grandchild"), { recursive: true });
    chmodSync(closed, 0o600);
    try {
      expect(ancestorTrust(join(closed, "grandchild", "child"))).toEqual({
        trusted: false,
        refusal: "unreadable",
        path: join(closed, "grandchild"),
      });
    } finally {
      chmodSync(closed, 0o700);
    }
  });

  test.skipIf(!ancestorTrust(tmpdir()).trusted)(
    "accepts an account-owned chain under the process temporary root",
    () => {
      const root = ownedRoot("clarvis-trust-accepted-");
      mkdirSync(join(root, "nested"), { mode: 0o700 });
      expect(ancestorTrust(join(root, "nested", "child"))).toEqual({ trusted: true });
    },
  );

  test("never judges the path itself, only what contains it", () => {
    const root = ownedRoot("clarvis-trust-self-");
    mkdirSync(join(root, "open"));
    chmodSync(join(root, "open"), 0o777);
    expect(ancestorTrust(join(root, "open")).trusted).toBe(ancestorTrust(root).trusted);
  });
});

describe("endpoint budget", () => {
  test("counts UTF-8 bytes, not characters", () => {
    expect(unixSocketPathFits("a".repeat(UNIX_SOCKET_PATH_BUDGET_BYTES))).toBe(true);
    expect(unixSocketPathFits("a".repeat(UNIX_SOCKET_PATH_BUDGET_BYTES + 1))).toBe(false);
    expect(unixSocketPathFits("é".repeat(UNIX_SOCKET_PATH_BUDGET_BYTES / 2))).toBe(true);
    expect(unixSocketPathFits("é".repeat(UNIX_SOCKET_PATH_BUDGET_BYTES / 2 + 1))).toBe(false);
  });

  test("honours an explicit budget", () => {
    expect(unixSocketPathFits(join("/tmp", "endpoint"), 8)).toBe(false);
    expect(unixSocketPathFits(join("/tmp", "endpoint"), 64)).toBe(true);
  });
});

describe("short temporary root candidates", () => {
  test("keeps only existing directories, canonical and deduplicated", () => {
    const root = ownedRoot("clarvis-candidates-");
    writeFileSync(join(root, "file"), "x");
    const accepted = shortTemporaryRootCandidates({
      candidates: [
        join(root, "missing"),
        join(root, "file"),
        root,
        join(root, "..", basename(root)),
      ],
      requireTrustedAncestors: false,
      budgetBytes: 4096,
    });
    expect(accepted).toEqual([resolve(realpathSync(root))]);
  });

  test("rejects a candidate that cannot fit when the caller requires the budget", () => {
    const root = ownedRoot("clarvis-candidates-budget-");
    const log = recorder();
    expect(
      shortTemporaryRootCandidates({
        candidates: [root],
        requireTrustedAncestors: false,
        budgetBytes: 8,
        requireBudget: true,
        logger: log.logger,
      }),
    ).toEqual([]);
    expect(log.events("paths.temporary_root_candidate_rejected")).toMatchObject([
      { candidate: resolve(realpathSync(root)), reason: "budget" },
    ]);
  });

  test("requires an account-owned chain unless the caller opts out", () => {
    const root = ownedRoot("clarvis-candidates-trust-");
    const open = join(root, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    expect(shortTemporaryRootCandidates({ candidates: [open], budgetBytes: 4096 })).toEqual([]);
    expect(
      shortTemporaryRootCandidates({
        candidates: [open],
        budgetBytes: 4096,
        requireTrustedAncestors: false,
      }),
    ).toEqual([resolve(realpathSync(open))]);
  });

  test("refuses an empty candidate list and the standard roots stay ordered", () => {
    expect(() => shortTemporaryRootCandidates({ candidates: [] })).toThrow(
      "short temporary root candidates must not be empty",
    );
    const standard = shortTemporaryRootCandidates({ budgetBytes: 4096 });
    expect(new Set(standard).size).toBe(standard.length);
    for (const candidate of standard) expect(ancestorTrust(candidate).trusted).toBe(true);
  });
});
