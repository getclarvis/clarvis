import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..", "..", "..");

/**
 * A code literal naming a Clarvis-owned directory: a quoted `.clarvis`/`.agents`
 * segment, or the temp prefix in any position.
 */
const LITERAL = /["'`]\.clarvis(?![-\w])|["'`]\.agents(?![-\w])|\.clarvis-tmp-/;

/**
 * Whether a line is comment text rather than code.
 *
 * @param line - one source line.
 * @returns `true` for TSDoc and block-comment continuation lines.
 *
 * @remarks
 * The distinction is load-bearing: TSDoc writes `` `.clarvis` `` in backticks,
 * which no regex can tell from a template literal. Documentation is expected to
 * name the directory; only computation must not.
 */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
}

/**
 * Files still spelling the vocabulary themselves, pending migration onto this
 * package.
 *
 * @remarks
 * Empty, and meant to stay that way: this package is now the sole owner of the
 * literal. The list exists so that a deliberate, reviewed exception can be
 * recorded rather than the assertion being weakened.
 */
const PENDING: readonly string[] = [];

/**
 * Trees scanned for the literal.
 *
 * @remarks `tooling/` is here because restricting the sweep to `src/` let the
 * vocabulary drift where nothing was watching: `packages/code/tooling/artifact/smoke.ts` seeded a
 * global HOME with hand-written joins, kept spelling
 * the pre-`@clarvis/paths` layout after it moved, and turned every CI run red at
 * a 90-second timeout that named neither the file nor the cause. A build or
 * fixture script computes real paths exactly as `src/` does.
 */
const SCANNED = ["packages/*/src/**/*.{ts,tsx}", "packages/*/tooling/**/*.{ts,tsx}"];

async function offenders(): Promise<string[]> {
  const found: string[] = [];
  for (const pattern of SCANNED) {
    for await (const match of new Glob(pattern).scan({ cwd: repoRoot })) {
      const rel = match.split(sep).join("/");
      if (rel.startsWith("packages/paths/")) continue;
      const text = await readFile(join(repoRoot, match), "utf8");
      if (text.split("\n").some((line) => !isComment(line) && LITERAL.test(line))) found.push(rel);
    }
  }
  return found.sort();
}

describe("the directory vocabulary is owned by @clarvis/paths", () => {
  test("only the files pending migration spell .clarvis or .agents in code", async () => {
    expect(await offenders()).toEqual([...PENDING].sort());
  });

  test("the pending list names no file that has already been migrated", async () => {
    const found = new Set(await offenders());
    expect(PENDING.filter((f) => !found.has(f))).toEqual([]);
  });

  test("the matcher recognises every form that appears in this codebase", () => {
    for (const line of [
      'path.join(workspaceRoot, ".clarvis")',
      'resolve(workspaceRoot, ".clarvis", "plans")',
      'join(home, ".agents", "skills")',
      "const tmp = path.join(dir, `.clarvis-tmp-${uniqueToken()}`);",
      'base.add(".git\\n.clarvis\\n.clarvis-tmp-*");',
      '"(original content preserved in an adjacent .clarvis-tmp-* backup)",',
    ]) {
      expect(isComment(line) || !LITERAL.test(line)).toBe(false);
    }
  });

  test("the matcher leaves TSDoc prose alone", () => {
    for (const line of [
      " * Ensure the workspace's `.clarvis` directory exists and is git-ignored.",
      " * Memory is a navigable markdown wiki under `<ws>/.clarvis/memory`.",
      "/** Workspace root; its `.clarvis` becomes the workspace config dir. */",
      "// eslint-disable-next-line -- the `.agents` root is read-only",
    ]) {
      expect(isComment(line)).toBe(true);
    }
  });

  test("the matcher does not fire on unrelated dotted names", () => {
    for (const line of ['join(dir, ".clarvisrc")', 'join(dir, ".agentsfile")', 'x(".git")']) {
      expect(LITERAL.test(line)).toBe(false);
    }
  });
});
