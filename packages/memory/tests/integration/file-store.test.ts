/**
 * Behaviour specific to the file-backed adapter: what it hides from the document
 * listing, the on-disk permissions it enforces, and the tree lock's stale-steal.
 * The backend-agnostic contract lives in store.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { TMP_PREFIX } from "@clarvis/paths";

import { createFileMemoryStore } from "../../src/file-store.ts";
import type { MemoryStore } from "../../src/types.ts";
import { makeRoot, seedFile } from "../helpers/fs.ts";

const modeBitsEnforced = process.platform !== "win32" && process.getuid?.() !== 0;

describe("file memory store", () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let store: MemoryStore;

  beforeEach(async () => {
    ({ root, cleanup } = await makeRoot());
    store = createFileMemoryStore({ root });
  });
  afterEach(() => cleanup());

  test("list ignores the lock dir, the ledger, dot-files and non-markdown files", async () => {
    await store.write("a/MEMORY.md", "x");
    await store.markIndexed("run-1");
    await seedFile(root, "notes.txt", "ignore me");
    await seedFile(root, ".hidden/MEMORY.md", "ignore me too");
    await seedFile(root, "a/MEMORY.md.4242.0.tmp", "half-written");
    await store.exclusive(async (tx) => {
      expect((await tx.list()).map((d) => d.path)).toEqual(["a/MEMORY.md"]);
    });
  });

  test.if(modeBitsEnforced)("creates the tree 0700 and documents 0600", async () => {
    await store.write("a/b/MEMORY.md", "x");
    const dir = await fs.stat(path.join(root, "a", "b"));
    const file = await fs.stat(path.join(root, "a", "b", "MEMORY.md"));
    expect(dir.mode & 0o777).toBe(0o700);
    expect(file.mode & 0o777).toBe(0o600);
  });

  test("leaves no tmp file behind after a write", async () => {
    await store.write("a/MEMORY.md", "x");
    expect(
      (await fs.readdir(path.join(root, "a"))).filter((n) => n.startsWith(TMP_PREFIX)),
    ).toEqual([]);
  });

  test("steals a stale lock whose holder process is gone", async () => {
    const lockDir = path.join(root, ".lock");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(lockDir, { mode: 0o700 });
    await fs.writeFile(path.join(lockDir, "holder"), "999999999.dead", "utf8");
    const stale = new Date(Date.now() - 120_000);
    await fs.utimes(lockDir, stale, stale);

    await store.exclusive(async (tx) => {
      await tx.write("a/MEMORY.md", "took it");
    });
    expect(await store.read("a/MEMORY.md")).toBe("took it");
  });

  // The holder is this very process, so it is unambiguously alive: that is the
  // branch whose deadline throw used to be swallowed by the handler meant to
  // interpret EEXIST, leaving the wait to spin on `stat` until the heat death
  // of the workspace.
  test("gives up instead of spinning when a live holder stops heartbeating", async () => {
    const lockDir = path.join(root, ".lock");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(lockDir, { mode: 0o700 });
    await fs.writeFile(path.join(lockDir, "holder"), `${String(process.pid)}.other`, "utf8");
    const stale = new Date(Date.now() - 120_000);
    await fs.utimes(lockDir, stale, stale);

    const waiting = createFileMemoryStore({
      root,
      lock: { staleMs: 60_000, timeoutMs: 300 },
    });
    const started = Date.now();
    await expect(waiting.exclusive(async () => "acquired")).rejects.toThrow(/timed out waiting/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("backs off between attempts rather than busy-looping on an unreadable lock", async () => {
    const lockDir = path.join(root, ".lock");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(lockDir, { mode: 0o700 });
    await fs.writeFile(path.join(lockDir, "holder"), `${String(process.pid)}.other`, "utf8");

    const waiting = createFileMemoryStore({ root, lock: { timeoutMs: 200 } });
    const started = Date.now();
    await expect(waiting.exclusive(async () => "acquired")).rejects.toThrow(/timed out waiting/);
    // Each attempt sleeps 25ms, so reaching a 200ms deadline cannot be instant.
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });
});
