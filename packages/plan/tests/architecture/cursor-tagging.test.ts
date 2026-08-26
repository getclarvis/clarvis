/**
 * Every producer of a plan paging cursor must stamp it, and every consumer must
 * decode it. A single unstamped mint is the failure mode that costs the most:
 * the byte-budget short page in the file adapter is reached only by a page of
 * many megabytes, so a cursor minted untagged there would be rejected by the
 * adapter's own decoder and turn a legal short page into a hard error, with no
 * cheap functional test in a position to see it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const src = join(import.meta.dir, "..", "..", "src");

function read(name: string): string {
  return readFileSync(join(src, name), "utf8");
}

/** Every `next_cursor:` mint expression in one module, minus the type positions. */
function mints(source: string): string[] {
  return [...source.matchAll(/next_cursor:\s*([^\n,}]+)/g)]
    .map((match) => match[1]!.trim())
    .filter((value) => value !== "unknown" && !value.startsWith("string"));
}

test("the file adapter stamps every cursor it mints, including the short page", () => {
  const source = read("file-repository.ts");
  const minted = mints(source);
  expect(minted.length).toBe(2);
  for (const expression of minted) expect(expression).toContain("fileCursor(");
  expect(source).toContain("fileCursorBound(query.cursor)");
});

test("the in-memory adapter stamps and decodes its own cursors", () => {
  const source = read("testing.ts");
  expect(source).toContain("encodePlanCursor(PLAN_CURSOR_TAGS.memory");
  expect(source).toContain("decodePlanCursor(PLAN_CURSOR_TAGS.memory");
});

test("the provider store wraps the remote's dialect on both sides", () => {
  const source = read("provider.ts");
  expect(source).toContain("encodePlanCursor(PLAN_CURSOR_TAGS.provider");
  expect(source).toContain("decodePlanCursor(PLAN_CURSOR_TAGS.provider");
});

test("no other module invents a plan cursor tag", () => {
  const owner = read("cursor.ts");
  expect(owner).toContain('file: "pf1"');
  expect(owner).toContain('memory: "pm1"');
  expect(owner).toContain('provider: "pp1"');
  for (const name of ["file-repository.ts", "testing.ts", "provider.ts", "store.ts"]) {
    const source = read(name);
    expect(source).not.toContain('"pf1');
    expect(source).not.toContain('"pm1');
    expect(source).not.toContain('"pp1');
  }
});
