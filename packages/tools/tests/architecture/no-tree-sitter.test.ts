/**
 * This package parses no source code, and nothing may put a parser back.
 *
 * @remarks
 * Two tools (`outline`, `check_syntax`), one optional peer dependency
 * (`@vscode/tree-sitter-wasm`), a capability flag threaded through the config,
 * the registry and the dispatcher, and a syntax warning appended to five write
 * results were removed together. Each of those was a separate mention site,
 * which is why this scans prose as well as code: the direct analogue,
 * `packages/loop/tests/architecture/no-feature-names.test.ts`, exists because a
 * feature's imports all left in one commit and a dozen TSDoc mentions stayed
 * behind — including one documenting a parameter the engine had stopped
 * declaring. `packages/paths/tests/architecture/invariant.test.ts` is the same
 * shape for the directory vocabulary.
 *
 * It also carries the guard that no type can express. `selectSurface` lost its
 * second parameter, and TypeScript cannot notice it coming back: `Function.length`
 * already stops at the first defaulted parameter, and `(a: boolean, b?: boolean)
 * => T` is assignable to `(a: boolean) => T`. The text scan below is the only
 * thing that fails when a conditional surface returns.
 *
 * **`web-tree-sitter` is a different package and a different concern.**
 * `@clarvis/code` depends on it for OpenTUI's syntax highlighting and must keep
 * it. Note that `/tree[-_ ]?sitter/i` matches that name too, which is why every
 * repository-wide rule here keys on the exact `@vscode/tree-sitter-wasm`
 * specifier and the word-level scan is confined to this package. The final
 * `describe` pins the distinction, so a later "finish the cleanup" pass cannot
 * read this file as licence to delete the highlighter.
 *
 * **The lockfile is the assertion, not module resolution.** An earlier draft
 * checked that `Bun.resolveSync` could no longer find the runtime. It can:
 * `bun install`, even with `--force`, leaves an orphaned package sitting in
 * `node_modules` after its last dependant drops it, so resolvability outlives
 * the dependency graph and that check would go red on every machine holding a
 * pre-existing install — for a reason having nothing to do with this package.
 * `bun.lock` is what a clean `--frozen-lockfile` install materialises, so it is
 * both the deterministic signal and the one that fails at the cause.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = join(PKG, "..", "..");
const PACKAGES = join(REPO, "packages");

/**
 * Files that must spell the forbidden vocabulary in order to assert its absence.
 *
 * @remarks Not exceptions to the rule but its enforcement: each of these fails
 * if a removed tool comes back. `no-tree-sitter.test.ts` is this file;
 * `tool-surface.test.ts` pins that both names dispatch as unknown tools and that
 * the refusal hands the model no way to install a runtime; and
 * `no-syntax-annotation.test.ts` pins that no write result carries the warning
 * that used to name `check_syntax`. Keep the list at three — anything else
 * naming these tokens is drift.
 */
const ASSERT_ABSENCE = new Set([
  "tests/architecture/no-tree-sitter.test.ts",
  "tests/component/tool-surface.test.ts",
  "tests/integration/no-syntax-annotation.test.ts",
]);

/**
 * The vocabulary, in every form it took in this package.
 *
 * @remarks `outline` is matched on a word boundary and only here, where the word
 * has no other sense. Repository-wide scans use `check_syntax`, which is
 * unambiguous — `outline` is an ordinary CSS and terminal-UI term in
 * `@clarvis/code`.
 */
const FORBIDDEN = [
  { name: "tree-sitter, in any spelling", pattern: /tree[-_ ]?sitter/i },
  { name: "the removed tool names", pattern: /\boutline\b|\bcheck_syntax\b/i },
  {
    name: "the capability flag",
    pattern: /treeSitterAvailable|probeTreeSitter|requiresTreeSitter|TREE_SITTER/,
  },
  { name: "the syntax annotation", pattern: /syntaxWarnings?\b|surface_degraded/ },
];

/** The npm specifier that must not exist anywhere in this repository. */
const WASM_RUNTIME = "@vscode/tree-sitter-wasm";

/** The one `@clarvis/code` owns, for a different purpose, which must survive. */
const HIGHLIGHTER = "web-tree-sitter";

/** Every file under `dir` matching one of `extensions`, recursively. */
function filesUnder(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, extensions));
    else if (extensions.some((extension) => entry.endsWith(extension))) out.push(full);
  }
  return out;
}

/** Every file this package is scanned through, as repo-relative paths. */
function packageFiles(): string[] {
  return [
    ...filesUnder(join(PKG, "src"), [".ts"]),
    ...filesUnder(join(PKG, "tests"), [".ts"]),
    join(PKG, "README.md"),
    join(PKG, "package.json"),
  ];
}

/** Every workspace manifest, so a reintroduction anywhere is visible here. */
function manifests(): string[] {
  return readdirSync(PACKAGES)
    .map((name) => join(PACKAGES, name, "package.json"))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
}

describe("@clarvis/tools carries no syntax runtime", () => {
  const files = packageFiles();

  it("scans the whole package, so a green run means something", () => {
    expect(files.length).toBeGreaterThan(80);
  });

  it.each(FORBIDDEN)("no file in the package names $name", ({ pattern }) => {
    const offenders = files
      .map((file) => ({ rel: relative(PKG, file).split("\\").join("/"), file }))
      .filter(({ rel }) => !ASSERT_ABSENCE.has(rel))
      .filter(({ file }) => pattern.test(readFileSync(file, "utf8")))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});

describe("no package reintroduces the wasm runtime", () => {
  it("no workspace manifest declares it, in any dependency block", () => {
    const offenders = manifests()
      .filter((file) => readFileSync(file, "utf8").includes(WASM_RUNTIME))
      .map((file) => relative(REPO, file).split("\\").join("/"));
    expect(offenders).toEqual([]);
  });

  it("the lockfile does not install it", () => {
    const lock = readFileSync(join(REPO, "bun.lock"), "utf8");
    const offenders = lock
      .split("\n")
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => line.includes(WASM_RUNTIME))
      .map(({ line, number }) => `bun.lock:${String(number)}: ${line}`);
    expect(offenders).toEqual([]);
  });

  it("no package's production source names a removed tool", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(PACKAGES)) {
      const src = join(PACKAGES, name, "src");
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of filesUnder(src, [".ts", ".tsx"])) {
        if (/\bcheck_syntax\b/.test(readFileSync(file, "utf8"))) {
          offenders.push(relative(REPO, file).split("\\").join("/"));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the highlighter @clarvis/code owns is a different package", () => {
  it("the two specifiers are not substrings of one another", () => {
    expect(HIGHLIGHTER.includes(WASM_RUNTIME)).toBe(false);
    expect(WASM_RUNTIME.includes(HIGHLIGHTER)).toBe(false);
  });

  it("the word-level matcher does fire on it, which is why the rules above name a specifier", () => {
    expect(/tree[-_ ]?sitter/i.test(HIGHLIGHTER)).toBe(true);
  });

  it("@clarvis/code still declares it and the lockfile still installs it", () => {
    const manifest = readFileSync(join(PACKAGES, "code", "package.json"), "utf8");
    expect(manifest).toContain(HIGHLIGHTER);
    expect(readFileSync(join(REPO, "bun.lock"), "utf8")).toContain(HIGHLIGHTER);
  });
});
