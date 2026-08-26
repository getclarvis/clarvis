/**
 * Behaviour specific to the file-backed repository: where it puts plans, the
 * confinement it enforces, the permissions it sets, and how it recovers a lock
 * whose holder died. The backend-agnostic contract lives in repository.test.ts.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { constants, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { mkdir, mkdtemp, open, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceStatePaths } from "@clarvis/paths";

import {
  createFilePlanRepository,
  digestText,
  InvalidPlanError,
  MAX_PLAN_DIRECTORY_ENTRIES,
  MAX_PLAN_DOCUMENT_BYTES,
  MAX_PLAN_FRONTMATTER_BYTES,
  newPlan,
  planFilename,
  projectPlan,
  renderPlan,
  type PlanRecord,
  type PlanRepository,
  PlanConflictError,
} from "@clarvis/plan";

const NOW = new Date("2026-07-27T10:00:00.000Z");

/** Mode bits are unobservable on Windows and meaningless under root. */
const modeBitsEnforced = process.platform !== "win32" && process.getuid?.() !== 0;

/**
 * Whether this host can link one directory to another at all. Probed rather
 * than assumed from the platform: Windows can, given Developer Mode or
 * elevation, so a blanket `skipIf(win32)` would drop coverage on a host that
 * actually supports it. Uses a junction on win32 - the only directory link
 * Windows creates without elevation - and a plain symlink everywhere else,
 * matching what the escape-check test below needs to create for real.
 */
const canLinkDirectories = ((): boolean => {
  const base = mkdtempSync(join(tmpdir(), "clarvis-plan-link-probe-"));
  const target = join(base, "target");
  try {
    mkdirSync(target);
    symlinkSync(target, join(base, "link"), process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
})();

function draft(title: string): Omit<PlanRecord, "digest"> {
  const document = newPlan({
    title,
    objective: "o",
    tasks: [{ title: "t" }],
    createdByRun: "run-1",
    now: NOW,
  });
  return {
    id: document.id,
    source: renderPlan(document),
    index: { ...projectPlan(document), path: planFilename(NOW, title) },
  };
}

async function fixture(): Promise<{ dir: string; repository: PlanRepository }> {
  const dir = await mkdtemp(join(tmpdir(), "clarvis-plan-file-"));
  return { dir, repository: createFilePlanRepository({ workspaceRoot: dir }) };
}

describe("file plan repository", () => {
  test("stores plans as workspace-relative markdown under .clarvis/plans", async () => {
    const { dir, repository } = await fixture();
    try {
      const created = await repository.create(draft("Ship the thing"));
      expect(created.index.path).toBe(".clarvis/plans/2026-07-27T10-00-00-ship-the-thing.md");
      expect(await readdir(join(dir, ".clarvis", "plans"))).toContain(
        "2026-07-27T10-00-00-ship-the-thing.md",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("suffixes a filename collision instead of overwriting", async () => {
    const { dir, repository } = await fixture();
    try {
      const first = await repository.create(draft("Same title"));
      const second = await repository.create(draft("Same title"));
      expect(second.index.path).not.toBe(first.index.path);
      expect(second.index.path).toMatch(/-2\.md$/);
      expect(
        (await readdir(join(dir, ".clarvis", "plans"))).filter((n) => n.endsWith(".md")),
      ).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("serializes duplicate-id detection with locator allocation", async () => {
    const { dir } = await fixture();
    try {
      const first = createFilePlanRepository({ workspaceRoot: dir });
      const second = createFilePlanRepository({ workspaceRoot: dir });
      const input = draft("Same identity");
      const outcomes = await Promise.allSettled([first.create(input), second.create(input)]);

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find((outcome) => outcome.status === "rejected");
      expect(rejected).toMatchObject({ reason: expect.any(PlanConflictError) });
      expect((await first.list()).records).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("releases the local queue and retries lock-directory creation after a transient failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarvis-plan-lock-dir-"));
    const blocker = join(dir, "lock-parent");
    const lockDir = join(blocker, "locks");
    await writeFile(blocker, "not a directory");
    const repository = createFilePlanRepository({ workspaceRoot: dir, lockDir });
    try {
      await expect(repository.create(draft("First attempt"))).rejects.toBeInstanceOf(Error);
      await rm(blocker);
      await mkdir(blocker);

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const recovered = await Promise.race([
          repository.create(draft("Recovered attempt")),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("plan lock queue remained wedged")), 1_000);
          }),
        ]);
        expect(recovered.index.title).toBe("Recovered attempt");
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("checks a delete baseline after a concurrent writer releases the plan lock", async () => {
    const { dir, repository } = await fixture();
    const other = createFilePlanRepository({ workspaceRoot: dir });
    const created = await repository.create(draft("Stale delete"));
    const target = join(dir, created.index.path);
    const realRename = fsp.rename.bind(fsp);
    let releaseRename!: () => void;
    const renameReached = Promise.withResolvers<void>();
    const renameRelease = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const renameSpy = spyOn(fsp, "rename").mockImplementation((async (from, to) => {
      if (to === target) {
        renameReached.resolve();
        await renameRelease;
      }
      return realRename(from, to);
    }) as typeof fsp.rename);
    try {
      const write = other.write({
        id: created.id,
        expectedDigest: created.digest,
        source: created.source.replace("## Notes\n", "## Notes\nnewer\n"),
        index: created.index,
      });
      await renameReached.promise;
      const deletion = repository.delete(created.id, created.digest);
      releaseRename();
      await write;

      await expect(deletion).rejects.toBeInstanceOf(PlanConflictError);
      expect((await repository.read(created.id))?.source).toContain("newer");
    } finally {
      releaseRename();
      renameSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.if(modeBitsEnforced)("creates the plans root 0700 and each plan 0600", async () => {
    const { dir, repository } = await fixture();
    try {
      const created = await repository.create(draft("Permissions"));
      const root = await stat(join(dir, ".clarvis", "plans"));
      const file = await stat(join(dir, created.index.path));
      expect(root.mode & 0o777).toBe(0o700);
      expect(file.mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("leaves no tmp file behind after create or write", async () => {
    const { dir, repository } = await fixture();
    try {
      const created = await repository.create(draft("Tidy"));
      await repository.write({
        id: created.id,
        expectedDigest: created.digest,
        source: `${created.source}\n`,
        index: created.index,
      });
      const entries = await readdir(join(dir, ".clarvis", "plans"));
      expect(entries.filter((n) => n.includes(".tmp"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.if(canLinkDirectories)(
    "refuses a plans root that escapes the workspace through a symlink",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "clarvis-plan-link-"));
      const outside = await mkdtemp(join(tmpdir(), "clarvis-plan-out-"));
      try {
        await mkdir(join(dir, ".clarvis"), { recursive: true });
        await symlink(
          outside,
          join(dir, ".clarvis", "plans"),
          process.platform === "win32" ? "junction" : "dir",
        );
        const repository = createFilePlanRepository({ workspaceRoot: dir });
        await expect(repository.create(draft("Escapee"))).rejects.toThrow(/symlink|directory/i);
      } finally {
        await rm(dir, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  test("never hands out a cursor whose next page the filters would empty", async () => {
    const { dir, repository } = await fixture();
    try {
      const at = (minute: number, title: string, retention: "keep" | "discard") => {
        const when = new Date(Date.UTC(2026, 6, 27, 10, minute, 0));
        const document = newPlan({
          title,
          objective: "o",
          tasks: [{ title: "t" }],
          retention,
          createdByRun: "run-1",
          now: when,
        });
        return {
          id: document.id,
          source: renderPlan(document),
          index: { ...projectPlan(document), path: planFilename(when, title) },
        };
      };
      // Newest first, so the three non-matching plans are the tail of the scan.
      for (const [minute, title, retention] of [
        [50, "keep-a", "keep"],
        [40, "keep-b", "keep"],
        [30, "drop-a", "discard"],
        [20, "drop-b", "discard"],
        [10, "drop-c", "discard"],
      ] as const) {
        await repository.create(at(minute, title, retention));
      }

      // The probe used to look for one more *filename*, which the discarded
      // plans supplied — so the caller got a cursor and the page after it was
      // empty.
      const full = await repository.list({ retention: "keep", limit: 2 });
      expect(full.records.map((record) => record.index.title)).toEqual(["keep-a", "keep-b"]);
      expect(full.next_cursor).toBeUndefined();

      const partial = await repository.list({ retention: "keep", limit: 1 });
      expect(partial.records.map((record) => record.index.title)).toEqual(["keep-a"]);
      expect(partial.next_cursor).toBeDefined();
      const next = await repository.list({
        retention: "keep",
        limit: 1,
        cursor: partial.next_cursor!,
      });
      expect(next.records.map((record) => record.index.title)).toEqual(["keep-b"]);
      expect(next.next_cursor).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores a non-markdown file sitting in the plans root", async () => {
    const { dir, repository } = await fixture();
    try {
      await repository.create(draft("Real plan"));
      await writeFile(join(dir, ".clarvis", "plans", "notes.txt"), "not a plan", "utf8");
      const page = await repository.list();
      expect(page.records).toHaveLength(1);
      expect(page.records[0]?.index.title).toBe("Real plan");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("steals a stale lockfile so an abandoned write cannot wedge the plan", async () => {
    const { dir, repository } = await fixture();
    try {
      const created = await repository.create(draft("Wedged"));
      const name = created.index.path.split("/").pop()!;
      const lockPath = join(workspaceStatePaths(dir).plansLockDir, `${name}.lock`);
      const handle = await open(lockPath, "w");
      await handle.close();
      const stale = new Date(Date.now() - 120_000);
      const { utimes } = await import("node:fs/promises");
      await utimes(lockPath, stale, stale);

      const written = await repository.write({
        id: created.id,
        expectedDigest: created.digest,
        source: created.source.replace("## Notes\n", "## Notes\nrecovered\n"),
        index: created.index,
      });
      expect(written.digest).not.toBe(created.digest);
      expect(written.digest).toBe(digestText(written.source));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("finds a plan by id after the in-process locator memo is cold", async () => {
    const { dir, repository } = await fixture();
    try {
      const created = await repository.create(draft("Cold start"));
      const fresh = createFilePlanRepository({ workspaceRoot: dir });
      const found = await fresh.read(created.id);
      expect(found?.id).toBe(created.id);
      expect(found?.index.path).toBe(created.index.path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("discovers an oversized sparse plan from its prefix without reading its body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarvis-plan-sparse-"));
    const root = join(dir, ".clarvis", "plans");
    const id = "sparse-plan";
    const target = join(root, "2026-07-27T10-00-00-sparse.md");
    await mkdir(root, { recursive: true });
    const sparse = await open(target, "w");
    await sparse.writeFile(`---\nid: ${id}\n`);
    await sparse.truncate(MAX_PLAN_DOCUMENT_BYTES + 1);
    await sparse.close();

    const realOpen = fsp.open.bind(fsp);
    let largestRead = 0;
    const openSpy = spyOn(fsp, "open").mockImplementation((async (path, flags, mode) => {
      const handle = await realOpen(path, flags, mode);
      if (path !== target) return handle;
      return new Proxy(handle, {
        get(file, property) {
          if (property === "read")
            return async (buffer: Buffer, offset: number, length: number, position: number) => {
              largestRead = Math.max(largestRead, length);
              return file.read(buffer, offset, length, position);
            };
          const value = Reflect.get(file, property);
          return typeof value === "function" ? value.bind(file) : value;
        },
      });
    }) as typeof fsp.open);
    try {
      const repository = createFilePlanRepository({ workspaceRoot: dir });
      await expect(repository.read(id)).rejects.toBeInstanceOf(InvalidPlanError);
      expect(largestRead).toBeLessThanOrEqual(MAX_PLAN_FRONTMATTER_BYTES);
      expect(await repository.delete(id)).toBeTrue();
      expect(largestRead).toBeLessThanOrEqual(MAX_PLAN_FRONTMATTER_BYTES);
    } finally {
      openSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects an oversized source before creating any plan file", async () => {
    const { dir, repository } = await fixture();
    try {
      const record = draft("Oversized write");
      record.source = "x".repeat(MAX_PLAN_DOCUMENT_BYTES + 1);
      await expect(repository.create(record)).rejects.toThrow(/exceeds/);
      await expect(readdir(join(dir, ".clarvis", "plans"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails explicitly when a directory scan exceeds its entry budget", async () => {
    const { dir, repository } = await fixture();
    const root = join(dir, ".clarvis", "plans");
    await mkdir(root, { recursive: true });
    const realOpendir = fsp.opendir.bind(fsp);
    const opendirSpy = spyOn(fsp, "opendir").mockImplementation((async (path, options) => {
      if (path !== root) return realOpendir(path, options);
      return {
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index <= MAX_PLAN_DIRECTORY_ENTRIES; index += 1)
            yield {
              name: `entry-${index}`,
              isFile: () => false,
            };
        },
      } as unknown as Awaited<ReturnType<typeof fsp.opendir>>;
    }) as typeof fsp.opendir);
    try {
      await expect(repository.list()).rejects.toThrow(`${MAX_PLAN_DIRECTORY_ENTRIES}`);
    } finally {
      opendirSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("file plan repository — owner-scoped roots", () => {
  test("an explicit root lands plans there and still reports a workspace-relative locator", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarvis-plan-owner-"));
    try {
      const repository = createFilePlanRepository({
        workspaceRoot: dir,
        root: join(dir, ".clarvis", "owners", "alice", "plans"),
      });
      const created = await repository.create(draft("Scoped"));

      expect(created.index.path).toBe(`.clarvis/owners/alice/plans/${planFilename(NOW, "Scoped")}`);
      expect(await readdir(join(dir, ".clarvis", "owners", "alice", "plans"))).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("two owner roots are mutually invisible", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarvis-plan-owner-"));
    try {
      const repoFor = (owner: string) =>
        createFilePlanRepository({
          workspaceRoot: dir,
          root: join(dir, ".clarvis", "owners", owner, "plans"),
        });
      const alice = repoFor("alice");
      const bob = repoFor("bob");

      const record = draft("Hers");
      await alice.create(record);

      expect((await alice.list({})).records).toHaveLength(1);
      expect((await bob.list({})).records).toHaveLength(0);
      expect(await bob.read(record.id)).toBeNull();
      expect(await alice.read(record.id)).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.if(modeBitsEnforced)("creates every intermediate owner directory at 0700", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarvis-plan-owner-"));
    try {
      const repository = createFilePlanRepository({
        workspaceRoot: dir,
        root: join(dir, ".clarvis", "owners", "alice", "plans"),
      });
      await repository.create(draft("Perms"));

      for (const p of [
        join(dir, ".clarvis", "owners", "alice", "plans"),
        join(dir, ".clarvis", "owners", "alice"),
        join(dir, ".clarvis", "owners"),
      ]) {
        expect((await stat(p)).mode & 0o777).toBe(0o700);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects a root outside the workspace rather than writing there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarvis-plan-owner-"));
    const outside = await mkdtemp(join(tmpdir(), "clarvis-plan-outside-"));
    try {
      const repository = createFilePlanRepository({ workspaceRoot: dir, root: outside });
      await expect(repository.list({})).rejects.toThrow(/escapes the workspace/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("rejects a not-yet-existing out-of-workspace root WITHOUT creating it first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarvis-plan-owner-"));
    const outsideParent = await mkdtemp(join(tmpdir(), "clarvis-plan-outside-"));
    const outsideRoot = join(outsideParent, "not", "yet", "created");
    try {
      const repository = createFilePlanRepository({ workspaceRoot: dir, root: outsideRoot });
      await expect(repository.list({})).rejects.toThrow(/escapes the workspace/);
      await expect(readdir(outsideParent)).resolves.toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outsideParent, { recursive: true, force: true });
    }
  });

  test("flattens a traversal-shaped locator into the owner's own root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarvis-plan-owner-"));
    try {
      const repository = createFilePlanRepository({
        workspaceRoot: dir,
        root: join(dir, ".clarvis", "owners", "alice", "plans"),
      });
      const record = draft("Escape");
      record.index = { ...record.index, path: "../bob/plans/stolen.md" };

      const created = await repository.create(record);

      expect(created.index.path).toBe(".clarvis/owners/alice/plans/stolen.md");
      expect(await readdir(join(dir, ".clarvis", "owners", "alice", "plans"))).toEqual([
        "stolen.md",
      ]);
      await expect(readdir(join(dir, ".clarvis", "owners", "bob"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("fsyncDir — the win32 directory-sync durability branch", () => {
  /**
   * Replaces `node:fs/promises`' `open` with one that fails exactly the
   * directory-handle open `fsyncDir` makes (`open(root, O_RDONLY)`, no mode
   * argument) and forwards every other call - the tmp-file open in
   * `atomicWrite` and the lockfile open in `withLock` both pass a `mode`, so
   * matching on `flags === O_RDONLY` alone already tells them apart.
   *
   * @remarks Spies on the `node:fs/promises` namespace object rather than
   * `node:fs`: `file-repository.ts` imports `open` by name from
   * `node:fs/promises`, and only a spy on that same module's namespace
   * intercepts calls made through that binding.
   */
  function interceptDirectoryOpen(root: string, failure: NodeJS.ErrnoException) {
    const realOpen = fsp.open.bind(fsp);
    return spyOn(fsp, "open").mockImplementation((async (
      path: Parameters<typeof fsp.open>[0],
      flags?: Parameters<typeof fsp.open>[1],
      mode?: Parameters<typeof fsp.open>[2],
    ) => {
      if (path === root && flags === constants.O_RDONLY) throw failure;
      return realOpen(path, flags, mode);
    }) as typeof fsp.open);
  }

  test("swallows a directory-open failure on win32, so the write still succeeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarvis-plan-fsyncdir-"));
    const root = join(dir, "plans");
    const originalPlatform = process.platform;
    const openSpy = interceptDirectoryOpen(
      root,
      Object.assign(new Error("simulated: cannot open a directory handle on win32"), {
        code: "EPERM",
      }),
    );
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const repository = createFilePlanRepository({ workspaceRoot: dir, root });
      const created = await repository.create(draft("Windows durability"));
      expect(created.index.path).toContain("windows-durability");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      openSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The mirror of the test above, and it pins the platform for the same reason
   * that one does: `fsyncDir` reads `process.platform` per call, so a test that
   * only *assumes* it is off win32 is really asserting whatever host it runs on.
   * That held until `@clarvis/plan` joined the Windows CI job, where the ambient
   * platform makes the swallow branch correct and this expectation impossible.
   * Skipping it there would have been the wrong repair: the branch under test is
   * platform-independent code, so the test should be too.
   */
  test("still propagates a directory-open failure off win32", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarvis-plan-fsyncdir-"));
    const root = join(dir, "plans");
    const originalPlatform = process.platform;
    const openSpy = interceptDirectoryOpen(
      root,
      Object.assign(new Error("simulated EIO opening the plans directory"), { code: "EIO" }),
    );
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const repository = createFilePlanRepository({ workspaceRoot: dir, root });
      await expect(repository.create(draft("Non-Windows durability"))).rejects.toThrow(
        /simulated EIO/,
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      openSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
