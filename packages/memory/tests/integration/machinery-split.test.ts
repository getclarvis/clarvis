import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workspacePaths, workspaceStatePaths } from "@clarvis/paths";

import { createFileMemoryStore } from "../../src/file-store.ts";
import type { MemoryStore } from "../../src/types.ts";

const made: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Split {
  workspaceRoot: string;
  wikiRoot: string;
  machineryRoot: string;
  store: MemoryStore;
}

function splitStore(): Split {
  const home = tempDir("clarvis-mem-home-");
  const workspaceRoot = tempDir("clarvis-mem-ws-");
  const env = { CLARVIS_HOME: home };
  const wikiRoot = workspacePaths(workspaceRoot).memoryRoot;
  const machineryRoot = workspaceStatePaths(workspaceRoot, { env }).memoryMachineryRoot;
  return {
    workspaceRoot,
    wikiRoot,
    machineryRoot,
    store: createFileMemoryStore({ root: wikiRoot, machineryRoot, workspaceRoot }),
  };
}

const DOC = "---\ndescription: a fact\n---\n\nbody\n";

async function namesUnder(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
}

/** Every entry under `dir`, recursively, as paths relative to it. */
async function treeUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    const entries = await fs
      .readdir(rel === "" ? dir : join(dir, rel), { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) stack.push(childRel);
      else out.push(childRel);
    }
  }
  return out.sort();
}

describe("the wiki and its machinery are separate trees", () => {
  test("the working tree receives only markdown, and its ignore file", async () => {
    const { workspaceRoot, wikiRoot, store } = splitStore();

    await store.exclusive(async (tx) => {
      await tx.write("infra/bun/MEMORY.md", DOC);
      await tx.markIndexed("run-1");
    });

    const inWiki = await treeUnder(wikiRoot);
    expect(inWiki).toEqual(["infra/bun/MEMORY.md"]);

    const inClarvis = await treeUnder(workspacePaths(workspaceRoot).clarvisDir);
    for (const entry of inClarvis) {
      expect(entry === ".gitignore" || entry.endsWith(".md")).toBe(true);
    }
  });

  test("history, journal, state and the lock all land outside the working tree", async () => {
    const { wikiRoot, machineryRoot, store } = splitStore();

    await store.exclusive(async (tx) => {
      await tx.batch({ source: { kind: "tool", tool: "write_memory" } }, (bx) =>
        bx.write("PROFILE.md", DOC),
      );
      await tx.batch({ source: { kind: "tool", tool: "write_memory" } }, (bx) =>
        bx.write("PROFILE.md", DOC.replace("body", "second")),
      );
      await tx.markIndexed("run-1");
    });

    const machinery = await namesUnder(machineryRoot);
    expect(machinery).toContain(".history");
    expect(machinery).toContain(".state");
    expect(await namesUnder(wikiRoot)).toEqual(["PROFILE.md"]);
  });

  test("a document still round-trips, and its revisions are readable", async () => {
    const { store } = splitStore();

    await store.exclusive(async (tx) => {
      await tx.batch({ source: { kind: "tool", tool: "write_memory" } }, (bx) =>
        bx.write("PROFILE.md", DOC),
      );
      await tx.batch({ source: { kind: "tool", tool: "write_memory" } }, (bx) =>
        bx.write("PROFILE.md", DOC.replace("body", "second")),
      );
    });

    expect(await store.read("PROFILE.md")).toContain("second");
    expect((await store.revisions.list("PROFILE.md")).length).toBeGreaterThan(0);
  });

  test("machineryRoot defaults to root, keeping a self-contained tree available", async () => {
    const root = tempDir("clarvis-mem-solo-");
    const store = createFileMemoryStore({ root });

    await store.exclusive(async (tx) => {
      await tx.write("PROFILE.md", DOC);
      await tx.markIndexed("run-1");
    });

    expect(await namesUnder(root)).toContain(".state");
    expect(await namesUnder(root)).toContain("PROFILE.md");
  });
});

describe("bookkeeping orphaned by a deleted wiki", () => {
  /**
   * The hazard the split introduces: the ledger used to be deleted along with
   * the wiki, because it lived inside it. Now it does not, so a user who
   * removes `<ws>/.clarvis/memory` to reset what the agent learned would find
   * every past run still marked indexed and the wiki empty for good.
   */
  test("a vanished wiki clears the indexed ledger so learning resumes", async () => {
    const { wikiRoot, machineryRoot, workspaceRoot, store } = splitStore();

    await store.exclusive(async (tx) => {
      await tx.write("PROFILE.md", DOC);
      await tx.markIndexed("run-1");
    });
    expect(await store.wasIndexed("run-1")).toBe(true);

    await fs.rm(wikiRoot, { recursive: true, force: true });

    const reopened = createFileMemoryStore({ root: wikiRoot, machineryRoot, workspaceRoot });
    expect(await reopened.wasIndexed("run-1")).toBe(false);
    expect(await reopened.list()).toEqual([]);
  });

  test("it does not clear the ledger while the wiki is merely empty", async () => {
    const { machineryRoot, wikiRoot, workspaceRoot, store } = splitStore();

    await store.exclusive(async (tx) => {
      await tx.markIndexed("run-1");
    });

    const reopened = createFileMemoryStore({ root: wikiRoot, machineryRoot, workspaceRoot });
    expect(await reopened.wasIndexed("run-1")).toBe(true);
  });

  test("a prepared batch never replays into a tree the user deleted", async () => {
    const { wikiRoot, machineryRoot, workspaceRoot, store } = splitStore();

    await store.exclusive(async (tx) => {
      await tx.write("PROFILE.md", DOC);
    });
    await fs.mkdir(join(machineryRoot, ".journal", "batch-x"), { recursive: true });
    await fs.writeFile(join(machineryRoot, ".journal", "batch-x", "prepare.json"), "{}");

    await fs.rm(wikiRoot, { recursive: true, force: true });

    const reopened = createFileMemoryStore({ root: wikiRoot, machineryRoot, workspaceRoot });
    await reopened.list();
    expect(await namesUnder(join(machineryRoot, ".journal"))).toEqual([]);
  });

  test("an unsplit store is left alone — its ledger dies with its tree anyway", async () => {
    const root = tempDir("clarvis-mem-solo2-");
    const store = createFileMemoryStore({ root });
    await store.exclusive(async (tx) => {
      await tx.markIndexed("run-1");
    });

    const reopened = createFileMemoryStore({ root });
    expect(await reopened.wasIndexed("run-1")).toBe(true);
  });
});
