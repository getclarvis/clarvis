import { describe, expect, it } from "../bun-test.ts";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const PACKAGES = join(SRC, "..", "..");

/**
 * The engine's own manifest — the authority for which `@clarvis/*` packages are
 * optional and which are hard.
 *
 * Both lists below are derived from it rather than written out, because the
 * failure mode of a hand-maintained frontier is a guard that silently walks less
 * of the graph while still reporting success. That is the same shape as the
 * blind spot this file's `SIDE_EFFECT_IMPORT` pattern exists to close.
 */
const ENGINE_MANIFEST = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

/** The `@clarvis/*` keys of one dependency block of {@link ENGINE_MANIFEST}. */
function clarvisDependencies(block: "dependencies" | "optionalDependencies"): string[] {
  return Object.keys(ENGINE_MANIFEST[block] ?? {})
    .filter((name) => name.startsWith("@clarvis/"))
    .sort();
}

/** The packages the engine declares as `optionalDependencies` — each may be
 * absent from an install that opted out of the matching `builtins.<feature>`. */
const OPTIONAL_PACKAGES = clarvisDependencies("optionalDependencies");

/**
 * The engine's hard `@clarvis/*` dependencies — always installed, so importing
 * one eagerly is fine, but their own imports are still part of the eager
 * closure. The walk follows these so a `@clarvis/*` barrel is not a wall the
 * guard stops at.
 */
const HARD_PACKAGES = clarvisDependencies("dependencies");

/** Public loop entries that do not explicitly opt into an optional feature. */
const NON_FEATURE_ENTRIES = ["lib.ts", "host.ts", "workflows.ts"] as const;

/** Memory's public capability entry, which sits above the engine but must remain
 * importable when the engine's optional feature packages are not installed. */
const MEMORY_CAPABILITY_ENTRY = join(PACKAGES, "memory", "src", "capability.ts");

/** The shared run harness must stay light until a case explicitly opts into a feature. */
const INTEGRATION_HARNESS_ENTRY = join(SRC, "..", "tests", "integration", "_helpers.ts");

/**
 * Every static `import`/`export … from "…"` except the `import type` /
 * `export type` forms, which the compiler erases.
 */
const BOUND_IMPORT = /^\s*(?:import|export)\s+(?!type\s)[^;]*?\bfrom\s*["']([^"']+)["']/gm;

/**
 * The bare side-effect form, `import "…"`, which has no `from` clause and so is
 * invisible to {@link BOUND_IMPORT} — yet loads and evaluates the module just as
 * completely. It cannot be type-only, so no exclusion applies. Omitting it is
 * how `import "@clarvis/skills/capability"` on an eager-path module would slip
 * past this whole file.
 */
const SIDE_EFFECT_IMPORT = /^\s*import\s*["']([^"']+)["']/gm;

/**
 * The specifiers one module's source actually loads at runtime. A `import(...)`
 * call is not static and is excluded, which is exactly the escape hatch
 * `importOptional` uses.
 */
function specifiersIn(source: string): string[] {
  const withoutDynamic = source.replace(/\bimport\s*\(/g, "importCall(");
  const out: string[] = [];
  for (const re of [BOUND_IMPORT, SIDE_EFFECT_IMPORT]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(withoutDynamic)) !== null) out.push(match[1]!);
  }
  return out;
}

/** {@link specifiersIn} over a file on disk. */
function staticSpecifiers(file: string): string[] {
  return specifiersIn(readFileSync(file, "utf8"));
}

/**
 * Resolve a workspace specifier naming one of {@link HARD_PACKAGES} to the
 * source file Bun loads for it, through that package's `exports` map under the
 * `"bun"` condition — the same condition the workspace link resolves with.
 *
 * @returns the absolute path, or `null` when the specifier names no hard
 *   package.
 * @throws Error when a hard package is imported at a subpath its `exports` map
 *   does not publish; that import would not resolve at runtime either, and
 *   swallowing it would reintroduce the blind spot this walk exists to close.
 */
function resolveHardPackage(specifier: string): string | null {
  const pkg = HARD_PACKAGES.find((p) => specifier === p || specifier.startsWith(`${p}/`));
  if (pkg === undefined) return null;
  const dir = join(PACKAGES, pkg.slice("@clarvis/".length));
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    exports?: Record<string, string | Record<string, string> | undefined>;
  };
  const subpath = specifier === pkg ? "." : `.${specifier.slice(pkg.length)}`;
  const entry = manifest.exports?.[subpath];
  const target = typeof entry === "string" ? entry : entry?.bun;
  if (target === undefined) {
    throw new Error(`'${specifier}' is not published by ${pkg}'s exports map under "bun"`);
  }
  return join(dir, target);
}

/**
 * Walks the static import graph from `entry`, staying inside the engine's `src/`
 * and the sources of its hard `@clarvis/*` dependencies.
 */
function staticallyReachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of staticSpecifiers(file)) {
      if (specifier.startsWith(".")) {
        queue.push(resolve(dirname(file), specifier));
        continue;
      }
      const hard = resolveHardPackage(specifier);
      if (hard !== null) queue.push(hard);
    }
  }
  return seen;
}

/** Every optional package named by a static import anywhere in `reachable`. */
function optionalPackagesLoadedBy(reachable: Set<string>): { file: string; pkg: string }[] {
  const offenders: { file: string; pkg: string }[] = [];
  for (const file of reachable) {
    for (const specifier of staticSpecifiers(file)) {
      const pkg = OPTIONAL_PACKAGES.find((p) => specifier === p || specifier.startsWith(`${p}/`));
      if (pkg !== undefined) offenders.push({ file: relative(PACKAGES, file), pkg });
    }
  }
  return offenders;
}

/**
 * Importing any non-feature engine entry must not require its optional feature
 * packages to be installed.
 *
 * `settings-specs.ts` is reached by the settings schema, the plugin schema and
 * the request schema — i.e. by everything — so one *value* import of an optional
 * package anywhere under it would load that package on every import of the
 * engine, and `builtins.<feature> = false` would stop meaning what it says. The
 * feature packages reach the engine through `importOptional`'s dynamic
 * `import()` instead, which this walk deliberately does not follow.
 *
 * Nothing else can see the property: an added `export *` breaks it with a green
 * typecheck, a green lint and a green suite.
 *
 * The walk follows the engine's hard `@clarvis/*` dependencies into their own
 * sources, because `settings-specs.ts` value-imports `@clarvis/capability` and
 * `@clarvis/supervision` and a barrel it stopped at would hide whatever that
 * barrel loads. Stopping at the package boundary left it inspecting 6 files of a
 * 43-file eager closure.
 *
 * The explicit `@clarvis/loop/capabilities/tools` subpath is intentionally kept
 * outside {@link NON_FEATURE_ENTRIES}: choosing that adapter opts into loading
 * tools. The root, host and workflows entries must keep every optional feature
 * behind a dynamic import so `builtins.<feature> = false` can correspond to a
 * genuinely absent package. In particular, a host barrel must not make an
 * otherwise-light constant such as `submit_result` drag in the coding tool
 * registry beside it.
 */
describe("the non-feature loop entries stay free of optional packages", () => {
  it("derives both package frontiers from the engine's manifest, and they partition it", () => {
    expect(OPTIONAL_PACKAGES.length).toBeGreaterThan(0);
    expect(HARD_PACKAGES.length).toBeGreaterThan(0);
    expect(HARD_PACKAGES.filter((pkg) => OPTIONAL_PACKAGES.includes(pkg))).toEqual([]);
    expect([...HARD_PACKAGES, ...OPTIONAL_PACKAGES].sort()).toEqual(
      [
        ...clarvisDependencies("dependencies"),
        ...clarvisDependencies("optionalDependencies"),
      ].sort(),
    );
  });

  it("loads no optional package from the capability settings specs", () => {
    const reachable = staticallyReachable(
      join(SRC, "runtime", "capabilities", "settings-specs.ts"),
    );
    expect(optionalPackagesLoadedBy(reachable)).toEqual([]);
  });

  for (const entry of NON_FEATURE_ENTRIES) {
    it(`loads no optional package from ${entry}`, () => {
      expect(optionalPackagesLoadedBy(staticallyReachable(join(SRC, entry)))).toEqual([]);
    });
  }

  it("confirms the explicit tools capability entry opts into @clarvis/tools", () => {
    expect(
      optionalPackagesLoadedBy(staticallyReachable(join(SRC, "capabilities-tools.ts"))),
    ).toContainEqual({ file: join("loop", "src", "capabilities-tools.ts"), pkg: "@clarvis/tools" });
  });

  it("loads no loop optional package from @clarvis/memory/capability", () => {
    const reachable = staticallyReachable(MEMORY_CAPABILITY_ENTRY);
    const files = [...reachable].map((file) => relative(PACKAGES, file));

    // Pin that the walk crossed the public entry's re-export into its runtime
    // factory closure rather than proving the invariant over one shallow file.
    expect(files).toContain(join("memory", "src", "capability.ts"));
    expect(files).toContain(join("memory", "src", "factory.ts"));
    expect(optionalPackagesLoadedBy(reachable)).toEqual([]);
  });

  it("loads no optional package from the integration harness by default", () => {
    expect(optionalPackagesLoadedBy(staticallyReachable(INTEGRATION_HARNESS_ENTRY))).toEqual([]);
  });

  it("still reaches the hooks settings block, so the walk is not vacuous", () => {
    const reachable = staticallyReachable(
      join(SRC, "runtime", "capabilities", "settings-specs.ts"),
    );
    const names = [...reachable].map((file) => file.split("/").pop());
    expect(names).toContain("hooks.ts");
    expect(names).toContain("tools-settings.ts");
    expect(names).toContain("skills-settings.ts");
  });

  it("walks into the hard @clarvis dependencies rather than stopping at the barrel", () => {
    const reachable = [
      ...staticallyReachable(join(SRC, "runtime", "capabilities", "settings-specs.ts")),
    ].map((file) => relative(PACKAGES, file));
    expect(reachable).toContain(join("capability", "src", "index.ts"));
    expect(reachable).toContain(join("supervision", "src", "index.ts"));
    expect(reachable.filter((f) => f.startsWith(`capability${sep}`)).length).toBeGreaterThan(5);
    expect(reachable.filter((f) => f.startsWith(`supervision${sep}`)).length).toBeGreaterThan(1);
  });

  it("confirms the deps builder reaches the feature packages only dynamically", () => {
    const buildRunDeps = join(SRC, "runtime", "build-run-deps.ts");
    const source = readFileSync(buildRunDeps, "utf8");
    for (const pkg of [
      "@clarvis/hooks/capability",
      "@clarvis/skills",
      "@clarvis/skills/capability",
    ]) {
      expect(source).toContain(`import("${pkg}")`);
    }
    expect(optionalPackagesLoadedBy(new Set([buildRunDeps]))).toEqual([]);
  });
});

// The guard above is only as good as its extractor, and the extractor is a regex over
// text. These pin the forms it must see and the forms it must not, so a gap shows up
// here rather than as a silently green walk. This is a second, independent copy of the
// one in packages/llm/tests/architecture/lazy-entry.test.ts, deliberately: @clarvis/llm may not import
// from packages/loop's tests, and a root tooling helper would fall outside both
// packages' tsconfig include.
describe("the specifier extractor the guard is built on", () => {
  it("sees a bare side-effect import, which has no `from` clause at all", () => {
    expect(specifiersIn('import "@clarvis/skills/capability";\n')).toEqual([
      "@clarvis/skills/capability",
    ]);
    expect(specifiersIn("import './hooks.ts';\n")).toEqual(["./hooks.ts"]);
  });

  it("sees the ordinary bound and re-export forms", () => {
    expect(specifiersIn('import { a } from "./a.ts";')).toEqual(["./a.ts"]);
    expect(specifiersIn('export * from "./b.ts";')).toEqual(["./b.ts"]);
    expect(specifiersIn('import x, { y } from "@clarvis/capability";')).toEqual([
      "@clarvis/capability",
    ]);
  });

  it("still erases the type-only forms and dynamic import", () => {
    expect(specifiersIn('import type { HookConfig } from "@clarvis/capability";')).toEqual([]);
    expect(specifiersIn('export type { X } from "./x.ts";')).toEqual([]);
    expect(specifiersIn('const m = await import("@clarvis/skills");')).toEqual([]);
  });

  it("counts a bound import exactly once, not twice", () => {
    expect(specifiersIn('import "./a.ts";\nimport { b } from "./b.ts";')).toEqual([
      "./b.ts",
      "./a.ts",
    ]);
  });

  it("resolves a hard package through its exports map under the bun condition", () => {
    expect(relative(PACKAGES, resolveHardPackage("@clarvis/capability")!)).toBe(
      join("capability", "src", "index.ts"),
    );
    expect(relative(PACKAGES, resolveHardPackage("@clarvis/capability/ports")!)).toBe(
      join("capability", "src", "ports.ts"),
    );
    expect(resolveHardPackage("@clarvis/skills")).toBeNull();
    expect(resolveHardPackage("zod")).toBeNull();
    expect(() => resolveHardPackage("@clarvis/capability/nope")).toThrow(
      "is not published by @clarvis/capability's exports map",
    );
  });
});
