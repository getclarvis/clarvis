import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isTmpFile, workspacePaths, workspaceStatePaths } from "@clarvis/paths";
import { createFileMemoryStore } from "@clarvis/memory";
import { createFilePlanRepository } from "@clarvis/plan";

/**
 * Everything `<ws>/.clarvis` is allowed to contain.
 *
 * @remarks The rule this file exists to hold: a working tree carries what a
 * human authors or reads, plus the explicitly ignored Git-owned checkout root,
 * and nothing else. `settings.json`, `agents/`,
 * `skills/`, `workflows/`, `plugins/` and `guard-judge.md` are a workspace's own
 * configuration and belong in its history; `plans/` and `memory/` are generated
 * Markdown the user is expected to open mid-run. Every byte of machinery —
 * monitor sidecars, output spills, prompt history, the memory wiki's journal and
 * index queue, the plan lockfiles — resolves through `workspaceStatePaths`
 * instead, under the user's global root.
 *
 * Most of that is enforced by the *type*: `WorkspacePaths` no longer has a key
 * naming any of it, so writing machinery into a repository is a compile error.
 * This suite covers what a type cannot — that the two generated trees actually
 * behave, and that no one reintroduces a hand-rolled `mkdir` beside them.
 *
 * It lives here because `@clarvis/kernel` is the lowest package that sees both
 * `@clarvis/plan` and `@clarvis/memory`. The monitor and spill writers cannot be
 * driven from here — the kernel does not depend on `@clarvis/tools` — and are
 * covered by the equivalent assertions in that package's `monitor-lib` and
 * `shell` suites and in the loop's `tool-spill` suite.
 */
const ALLOWED_TOP_LEVEL = new Set([
  ".gitignore",
  "settings.json",
  "agents",
  "skills",
  "workflows",
  "plugins",
  "guard-judge.md",
  "plans",
  "memory",
  "owners",
  "worktrees",
]);

const made: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Every file under `dir`, recursively, as `/`-joined relative paths. */
async function filesUnder(dir: string): Promise<string[]> {
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

/**
 * Drive every writer that touches a workspace, then report what landed in it.
 *
 * @returns the workspace root and the relative paths found under its `.clarvis`.
 */
async function exerciseWriters(): Promise<{ workspaceRoot: string; inClarvis: string[] }> {
  const home = tempDir("clarvis-surface-home-");
  const workspaceRoot = tempDir("clarvis-surface-ws-");
  process.env.CLARVIS_HOME = home;

  const ws = workspacePaths(workspaceRoot);
  const state = workspaceStatePaths(workspaceRoot);

  const plans = createFilePlanRepository({ workspaceRoot });
  await plans.list();

  const memory = createFileMemoryStore({
    root: ws.memoryRoot,
    machineryRoot: state.memoryMachineryRoot,
    workspaceRoot,
  });
  const doc = "---\ndescription: a fact\n---\n\nbody\n";
  await memory.exclusive(async (tx) => {
    await tx.batch({ source: { kind: "tool", tool: "write_memory" } }, (bx) =>
      bx.write("infra/bun/MEMORY.md", doc),
    );
    await tx.batch({ source: { kind: "tool", tool: "write_memory" } }, (bx) =>
      bx.write("infra/bun/MEMORY.md", doc.replace("body", "revised")),
    );
    await tx.markIndexed("run-1");
  });

  return { workspaceRoot, inClarvis: await filesUnder(ws.clarvisDir) };
}

describe("what a run may leave in a user's working tree", () => {
  test("every top-level entry is authored config or generated markdown", async () => {
    const { workspaceRoot, inClarvis } = await exerciseWriters();
    expect(inClarvis.length).toBeGreaterThan(0);
    for (const rel of inClarvis) {
      expect(ALLOWED_TOP_LEVEL).toContain(rel.split("/")[0]);
    }
    expect(await filesUnder(workspaceRoot)).toEqual(
      inClarvis.map((rel) => `.clarvis/${rel}`).sort(),
    );
  });

  test("plans/ and memory/ hold only .md, plus a transient atomic-write temp", async () => {
    const { inClarvis } = await exerciseWriters();
    const generated = inClarvis.filter(
      (rel) => rel.startsWith("plans/") || rel.startsWith("memory/"),
    );
    expect(generated.length).toBeGreaterThan(0);
    for (const rel of generated) {
      const name = rel.slice(rel.lastIndexOf("/") + 1);
      expect(name.endsWith(".md") || isTmpFile(name)).toBe(true);
    }
  });

  /**
   * The defect that motivated all of this: `code`'s prompt history fired on the
   * first Enter, before any tool had run, through a bare recursive `mkdir` — so
   * the ignore file existed only if some other writer happened to go first, and
   * a fresh repository reported `?? .clarvis/` after one prompt.
   */
  test("the ignore file is present whichever writer created the directory first", async () => {
    const { inClarvis } = await exerciseWriters();
    expect(inClarvis).toContain(".gitignore");
  });

  test("no machinery reaches the working tree", async () => {
    const { inClarvis } = await exerciseWriters();
    for (const rel of inClarvis) {
      const name = rel.slice(rel.lastIndexOf("/") + 1);
      expect(name.endsWith(".lock")).toBe(false);
      expect(rel.split("/")).not.toContain(".journal");
      expect(rel.split("/")).not.toContain(".state");
      expect(rel.split("/")).not.toContain(".history");
      expect(rel.split("/")).not.toContain("local");
    }
  });

  test("the machinery is all present in the state tree instead", async () => {
    const { workspaceRoot } = await exerciseWriters();
    const inState = await filesUnder(workspaceStatePaths(workspaceRoot).root);
    expect(inState.some((rel) => rel.startsWith("memory/.state/"))).toBe(true);
    expect(inState.some((rel) => rel.startsWith("memory/.history/"))).toBe(true);
  });
});
