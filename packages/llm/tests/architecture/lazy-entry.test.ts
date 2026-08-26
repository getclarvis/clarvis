import { describe, expect, it } from "../helpers/bun-test.ts";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

/**
 * Every static `import`/`export … from "…"` except the `import type` /
 * `export type` forms, which the compiler erases. An import whose bindings are
 * all inline `type`s is counted as loading, which over-approximates in the safe
 * direction.
 */
const BOUND_IMPORT = /^\s*(?:import|export)\s+(?!type\s)[^;]*?\bfrom\s*["']([^"']+)["']/gm;

/**
 * The bare side-effect form, `import "…"`, which has no `from` clause and so is
 * invisible to {@link BOUND_IMPORT} — yet loads and evaluates the module just as
 * completely. It cannot be type-only, so no exclusion applies. Omitting it is
 * how `import "./ai-sdk-adapter.ts"` would slip past this whole file.
 */
const SIDE_EFFECT_IMPORT = /^\s*import\s*["']([^"']+)["']/gm;

/**
 * The specifiers one module's source actually loads at runtime. A `import(...)`
 * call is not static and is excluded, which is exactly the escape hatch the lazy
 * entry uses.
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

/** Walks the static import graph from `entry`, staying inside the package. */
function staticallyReachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of staticSpecifiers(file)) {
      if (!specifier.startsWith(".")) continue;
      const next = resolve(dirname(file), specifier);
      queue.push(next);
    }
  }
  return seen;
}

/**
 * The package's two entries exist so that importing a decorator does not load
 * four provider SDKs. Nothing else can see that property: adding
 * `export * from "./ai-sdk-adapter.ts"` to `src/index.ts` breaks it with a green
 * typecheck, a green lint and a green suite.
 */
describe("the main entry stays free of the provider SDKs", () => {
  const reachable = staticallyReachable(join(SRC, "index.ts"));

  it("does not statically reach the adapter", () => {
    expect([...reachable].filter((f) => f.endsWith("ai-sdk-adapter.ts"))).toEqual([]);
  });

  it("does not statically reach stream metrics either", () => {
    expect([...reachable].filter((f) => f.endsWith("stream-metrics.ts"))).toEqual([]);
  });

  it("names no provider SDK in anything it reaches", () => {
    const offenders = [...reachable].filter((file) =>
      staticSpecifiers(file).some(
        (specifier) => specifier === "ai" || specifier.startsWith("@ai-sdk/"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("still reaches the decorators, so the walk is not vacuous", () => {
    const names = [...reachable].map((file) => file.split("/").pop());
    expect(names).toContain("retry-llm-provider.ts");
    expect(names).toContain("logging-llm-provider.ts");
    expect(names).toContain("lazy.ts");
  });

  it("confirms the adapter entry is the one that does load them", () => {
    const viaAdapter = staticallyReachable(join(SRC, "adapter.ts"));
    expect([...viaAdapter].some((f) => f.endsWith("ai-sdk-adapter.ts"))).toBe(true);
  });
});

// The guard above is only as good as its extractor, and the extractor is a regex over
// text. These pin the forms it must see and the forms it must not, so a gap shows up
// here rather than as a silently green walk.
describe("the specifier extractor the guard is built on", () => {
  it("sees a bare side-effect import, which has no `from` clause at all", () => {
    expect(specifiersIn('import "./ai-sdk-adapter.ts";\n')).toEqual(["./ai-sdk-adapter.ts"]);
    expect(specifiersIn("import 'ai';\n")).toEqual(["ai"]);
    expect(specifiersIn('import "@ai-sdk/openai";\n')).toEqual(["@ai-sdk/openai"]);
  });

  it("sees the ordinary bound and re-export forms", () => {
    expect(specifiersIn('import { a } from "./a.ts";')).toEqual(["./a.ts"]);
    expect(specifiersIn('export * from "./b.ts";')).toEqual(["./b.ts"]);
    expect(specifiersIn('import x, { y } from "ai";')).toEqual(["ai"]);
  });

  it("still erases the type-only forms and dynamic import", () => {
    expect(specifiersIn('import type { LanguageModel } from "ai";')).toEqual([]);
    expect(specifiersIn('export type { X } from "./x.ts";')).toEqual([]);
    expect(specifiersIn('const m = await import("./ai-sdk-adapter.ts");')).toEqual([]);
  });

  it("counts a bound import exactly once, not twice", () => {
    expect(specifiersIn('import "./a.ts";\nimport { b } from "./b.ts";')).toEqual([
      "./b.ts",
      "./a.ts",
    ]);
  });
});
