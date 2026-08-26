import { describe, expect, it } from "../bun-test.ts";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * The import forms that make one package load another: a static
 * `import`/`export … from`, a bare side-effect `import "…"`, and a dynamic
 * `import("…")`. Each is anchored on the engine's specifier, with or without one
 * of its published subpaths.
 *
 * @remarks Every form matches an import *specifier*, never a bare package name.
 * Several of these packages name the engine in TSDoc prose — `skills`' test
 * helpers explain that they carry hand-written copies of the engine's capability
 * fakes precisely *because* they may not import it — and a guard that fired on
 * the mention would punish the file documenting the rule.
 *
 * `import type` is matched too. A type-only import is erased from the JavaScript,
 * so it cannot deadlock a module graph, but it is still an edge the manifest and
 * `tsc -b`'s project references must carry — and here that edge is a cycle.
 */
const ENGINE_IMPORT: readonly RegExp[] = [
  /\bfrom\s*["'](@clarvis\/loop(?:\/[^"']*)?)["']/g,
  /^\s*import\s*["'](@clarvis\/loop(?:\/[^"']*)?)["']/g,
  /\bimport\s*\(\s*["'](@clarvis\/loop(?:\/[^"']*)?)["']/g,
];

/**
 * Whether a line is comment text rather than code.
 *
 * @param line - one source line.
 * @returns `true` for TSDoc, block-comment continuations and `//` comments.
 */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
}

/** Every engine specifier one source line imports. */
function engineImportsInLine(line: string): string[] {
  if (isComment(line)) return [];
  const found: string[] = [];
  for (const form of ENGINE_IMPORT) {
    form.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = form.exec(line)) !== null) found.push(hit[1]!);
  }
  return found;
}

/**
 * A quoted `@clarvis/…` specifier, assembled at runtime.
 *
 * @param subpath - everything after the scope, e.g. `loop/host`.
 * @returns the specifier wrapped in double quotes.
 *
 * @remarks The fixture lines below are built rather than written out because
 * `packages/paths/tests/architecture/invariant.test.ts` sweeps every package's sources for
 * import specifiers and holds each one against that package's manifest. A
 * fixture written as a real import statement would advertise an edge this
 * package does not have.
 */
function scoped(subpath: string): string {
  return `"@clarvis/${subpath}"`;
}

/**
 * The `@clarvis/*` packages the engine declares, read from its manifest rather
 * than listed here, so the guard keeps covering the graph as the graph changes.
 *
 * @remarks `optionalDependencies` is included: optional means *absentable at
 * install time*, not *outside the DAG*. A cycle through one is still a cycle.
 */
function enginePackageDependencies(): string[] {
  const manifest = JSON.parse(readFileSync(join(PACKAGES, "loop", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]
    .filter((name) => name.startsWith("@clarvis/"))
    .sort();
}

/**
 * Trees scanned inside each dependency.
 *
 * @remarks `tests` is deliberately in scope. The rule is not merely that the
 * *build* graph is acyclic — a cold `tsc -b` would reject that — it is that a
 * package the engine depends on cannot reach the engine at all, which is why
 * `@clarvis/skills` carries a hand-written copy of the engine's capability fakes
 * instead of importing `src/runtime/capabilities/testing.ts`. A test-only import would be a
 * `devDependency` cycle that no build, no install and no consumer ever sees.
 */
const SCANNED_TREES = ["src", "tests"];

/** One file that imports the engine from a package that must not. */
interface Offender {
  readonly file: string;
  readonly specifier: string;
}

/** Every engine import inside one dependency package, with the file it sits in. */
function engineImportsIn(pkg: string): { offenders: Offender[]; scanned: number } {
  const dir = pkg.slice("@clarvis/".length);
  const offenders: Offender[] = [];
  let scanned = 0;
  for (const tree of SCANNED_TREES) {
    for (const match of new Glob(`${dir}/${tree}/**/*.{ts,tsx}`).scanSync({ cwd: PACKAGES })) {
      const rel = match.split(sep).join("/");
      scanned += 1;
      for (const line of readFileSync(join(PACKAGES, match), "utf8").split("\n")) {
        for (const specifier of engineImportsInLine(line)) {
          offenders.push({ file: `packages/${rel}`, specifier });
        }
      }
    }
  }
  return { offenders, scanned };
}

/**
 * Nothing the engine depends on may depend on the engine.
 *
 * @remarks This is the assertion `AGENTS.md` describes as living in the engine's
 * own suite, "since only a test can see both sides". Only a test can: from
 * inside `@clarvis/hooks` the engine is not visible at all, and from inside the
 * engine a new edge in a dependency looks like any other import. `knip` and a
 * *cold* `tsc -b` do reject a cycle, but a warm incremental build with the
 * dependency declared passes build, typecheck, lint, knip and both suites with
 * the cycle in place — which is exactly the state a developer is in at the moment
 * they add one.
 *
 * The direction is the mirror of `optional-package-loading.test.ts`: that file
 * walks *out* of the engine and proves the eager configuration path never
 * reaches an optional package; this one walks *in* from every dependency and
 * proves none of them reaches back.
 */
describe("no package the engine depends on imports the engine", () => {
  it("reads the dependency list from the engine's own manifest", () => {
    const deps = enginePackageDependencies();
    expect(deps).toContain("@clarvis/capability");
    expect(deps).toContain("@clarvis/supervision");
    expect(deps.length).toBeGreaterThanOrEqual(5);
  });

  it("finds no import of the engine in any of them", () => {
    const offenders = enginePackageDependencies().flatMap((pkg) => engineImportsIn(pkg).offenders);
    expect(offenders).toEqual([]);
  });

  it("read files in every dependency, so an empty result means something", () => {
    for (const pkg of enginePackageDependencies()) {
      expect({ pkg, read: engineImportsIn(pkg).scanned > 0 }).toEqual({ pkg, read: true });
    }
  });

  it("recognises every import form, including the published subpaths", () => {
    const cases: [line: string, expected: string][] = [
      [`import { executeRun } from ${scoped("loop")};`, "@clarvis/loop"],
      [`import type { Grant } from ${scoped("loop")};`, "@clarvis/loop"],
      [`import { settingsSchemaFor } from ${scoped("loop/host")};`, "@clarvis/loop/host"],
      [`export { runDispatch } from ${scoped("loop/internal")};`, "@clarvis/loop/internal"],
      [`import ${scoped("loop")};`, "@clarvis/loop"],
      [`  const mod = await import(${scoped("loop/workflows")});`, "@clarvis/loop/workflows"],
      [`} from ${scoped("loop/capabilities/tools")};`, "@clarvis/loop/capabilities/tools"],
    ];
    for (const [line, expected] of cases) {
      expect(engineImportsInLine(line)).toEqual([expected]);
    }
  });

  it("ignores the engine named in prose or held as a plain string", () => {
    for (const line of [
      ` * ${scoped("loop")} ships equivalents in \`src/runtime/capabilities/testing.ts\`.`,
      ` * See {@link import(${scoped("loop")}).Grant | Grant} for the manager grant.`,
      `// Guards the move out of ${scoped("loop")}: the engine injects an Ajv-backed`,
      `/* ${scoped("loop")} is the consumer here */`,
      `const ENGINE = ${scoped("loop")};`,
      `expect(source).toContain(${scoped("loop/host")});`,
    ]) {
      expect(engineImportsInLine(line)).toEqual([]);
    }
  });

  it("does not mistake a differently-named package for the engine", () => {
    for (const line of [
      `import { x } from ${scoped("loopback")};`,
      `import { y } from ${scoped("supervision")};`,
    ]) {
      expect(engineImportsInLine(line)).toEqual([]);
    }
  });
});
