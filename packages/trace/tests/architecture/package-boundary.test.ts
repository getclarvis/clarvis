/**
 * `@clarvis/trace` sits below the engine, and nothing was checking.
 *
 * @remarks The dependency graph puts this package under `@clarvis/loop`: the
 * engine decides *when* to record, this decides *how* a record is written and
 * kept. An import of `@clarvis/loop` from here would close a cycle, and the way
 * it would arrive is a test reaching for a convenient fixture — which no manifest
 * check can see, because a `devDependency` import from `src/` type-checks,
 * bundles and passes every suite.
 *
 * So this reads the manifest *and* the source; the two together are what make
 * the boundary real.
 */
import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const PKG = resolve(import.meta.dir, "..", "..");

/**
 * This file, excluded from its own scan: the fixture that proves the matcher
 * works has to contain the very import forms the matcher looks for.
 */
const SELF = "tests/architecture/package-boundary.test.ts";

/** Packages this one may never reach, in either direction of the graph. */
const FORBIDDEN = [
  "@clarvis/loop",
  "@clarvis/kernel",
  "@clarvis/protocol",
  "@clarvis/code",
  "@clarvis/server",
  "@clarvis/memory",
  "@clarvis/plan",
  "@clarvis/workflows",
  "@clarvis/tools",
  "@clarvis/hooks",
  "@clarvis/skills",
];

/** Every static, side-effect and dynamic import form in one file. */
function importedModules(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']/g))
    out.push(m[1]!);
  for (const m of text.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of text.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g)) out.push(m[1]!);
  return out;
}

async function filesUnder(dir: string): Promise<{ rel: string; text: string }[]> {
  const out: { rel: string; text: string }[] = [];
  for await (const match of new Glob("**/*.ts").scan({ cwd: join(PKG, dir) })) {
    const rel = `${dir}/${match.split(sep).join("/")}`;
    out.push({ rel, text: await readFile(join(PKG, dir, match), "utf8") });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** `<path>: <module>` for each forbidden import, in whichever tree it appears. */
async function crossings(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const { rel, text } of await filesUnder(dir)) {
    if (rel === SELF) continue;
    for (const specifier of importedModules(text)) {
      const owner = FORBIDDEN.find((p) => specifier === p || specifier.startsWith(`${p}/`));
      if (owner !== undefined) found.push(`${rel}: ${specifier}`);
    }
  }
  return found;
}

describe("the trace package's dependency boundary", () => {
  it("declares only the two leaves it sits on, and no external package", async () => {
    const manifest = JSON.parse(await readFile(join(PKG, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@clarvis/capability",
      "@clarvis/paths",
    ]);
    expect(Object.keys(manifest.devDependencies ?? {})).toEqual([]);
  });

  it("scans a non-trivial number of files, so a green run means something", async () => {
    expect((await filesUnder("src")).length).toBeGreaterThan(5);
    expect((await filesUnder("tests")).length).toBeGreaterThan(5);
  });

  it("imports no package that sits above it, from src", async () => {
    expect(await crossings("src")).toEqual([]);
  });

  it("imports none from tests either, where a devDependency cycle would hide", async () => {
    expect(await crossings("tests")).toEqual([]);
  });

  /**
   * The fixture builds each specifier by concatenation rather than writing it
   * out. `@clarvis/loop` runs a mirror scan over every package it depends on,
   * and a literal `from "@clarvis/loop"` here — inside a string, in a test that
   * exists to forbid exactly that import — is indistinguishable from the real
   * thing to any line-based matcher, including this one.
   */
  it("recognises every import form it claims to scan", () => {
    const pkg = (name: string): string => `@clarvis/${name}`;
    const text = [
      `import { a } from "${pkg("loop")}";`,
      `import "${pkg("kernel")}/bootstrap";`,
      `const m = await import("${pkg("code")}");`,
      `const r = require("${pkg("server")}");`,
    ].join("\n");
    expect(importedModules(text)).toEqual([
      pkg("loop"),
      `${pkg("kernel")}/bootstrap`,
      pkg("code"),
      pkg("server"),
    ]);
  });
});

/**
 * `capDetail` is the only cap table, and double-capping is why that matters.
 *
 * @remarks `truncate` is idempotent at a fixed `max` but not across differing
 * ones: capping at `n` and then at some `m` just above `n` cuts into the first
 * `...[truncated]` marker and leaves a mangled one. So a second module declaring
 * its own bounds does not merely duplicate a number — it corrupts the very
 * marker that tells a reader the value was shortened.
 *
 * `cap-detail.ts`'s own suite exercises the function thoroughly; what it cannot
 * see is another module quietly growing a second table. This checks the shape of
 * that mistake: a cap constant, or a raw character slice of a detail value,
 * declared outside the owner.
 */
describe("one module owns the trace detail bounds", () => {
  const OWNER = "src/cap-detail.ts";

  /**
   * Only the *character* caps, not the store's byte and list bounds. A record
   * size limit or a list page cap is a different kind of number: exceeding one
   * is refused or paged, never silently shortened, so two of them cannot corrupt
   * each other the way two string caps can.
   */
  const CHARACTER_CAPS =
    /\bexport\s+const\s+(?:TRUNCATED_SUFFIX|DETAIL_TRUNCATED_KEY|DETAIL_MAX_\w+|RESULT_MAX|SUMMARY_MAX|DIFF_MAX|ARGS_MAX|ARGS_TOTAL_MAX|LIVE_CHUNK_MAX|MODEL_RESPONSE_MAX)\s*=/;

  it("declares every detail character cap in exactly one module", async () => {
    const declaring: string[] = [];
    for (const { rel, text } of await filesUnder("src")) {
      if (CHARACTER_CAPS.test(text)) declaring.push(rel);
    }
    expect(declaring).toEqual([OWNER]);
  });

  it("the owner really declares them, so the matcher is not vacuous", async () => {
    const owner = (await filesUnder("src")).find(({ rel }) => rel === OWNER)!;
    expect(CHARACTER_CAPS.test(owner.text)).toBe(true);
    expect(owner.text).toContain("TRUNCATED_SUFFIX");
  });

  it("no other module re-slices a capped value into its own bound", async () => {
    const offenders: string[] = [];
    for (const { rel, text } of await filesUnder("src")) {
      if (rel === OWNER) continue;
      text.split("\n").forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("*") || t.startsWith("//")) return;
        if (/\bdetail\b[^\n]*\.slice\s*\(\s*0\s*,/.test(line))
          offenders.push(`${rel}:${String(i + 1)}`);
        if (/\.slice\s*\(\s*0\s*,[^)]*MAX/.test(line)) offenders.push(`${rel}:${String(i + 1)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("every module that bounds a detail reaches the owner to do it", async () => {
    const bounding = (await filesUnder("src")).filter(
      ({ rel, text }) => rel !== OWNER && text.includes("detail:"),
    );
    expect(bounding.length).toBeGreaterThan(0);
    for (const { rel, text } of bounding) {
      expect([rel, text.includes("capDetail")]).toEqual([rel, true]);
    }
  });
});
