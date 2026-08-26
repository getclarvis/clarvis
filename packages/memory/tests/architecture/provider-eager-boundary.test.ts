/**
 * The provider registry must reach every implementation through a **dynamic**
 * `import()`.
 *
 * `@clarvis/memory/settings` sits on the eager import path — it is what makes
 * the `memory:` block parse at all — so a registry that value-imported its
 * implementations would pull every provider's code, eventually including a
 * plugin's, into every import of the kernel. Nothing else can see that
 * regression: it survives a green typecheck, a green lint and a green suite,
 * because a static import is a perfectly valid program.
 *
 * This walks the registry's own source rather than the module graph at runtime,
 * because a runtime probe would already have paid the cost it is checking for.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");
const registry = readFileSync(join(SRC, "provider-registry.ts"), "utf8");

/** Implementation modules that must never be reachable statically from the registry. */
const IMPLEMENTATIONS = [
  "./wiki-provider.ts",
  "./file-provider.ts",
  "./mcp-provider.ts",
  "./executable-provider.ts",
];

/**
 * Every specifier reached by a **value** import.
 *
 * @remarks `import type` is deliberately excluded: it is erased at compile time
 * and pulls no module in at runtime, so the registry naming a provider's *types*
 * statically costs nothing. It is the value import that would load the code.
 */
function staticSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /^\s*import\s+(?!type\s)(?:[^"';]*?from\s+)?["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]!);
  return out;
}

/** Every `import("x")` specifier in a source text. */
function dynamicSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]!);
  return out;
}

describe("the provider registry's import boundary", () => {
  const statics = staticSpecifiers(registry);
  const dynamics = dynamicSpecifiers(registry);

  it.each(IMPLEMENTATIONS)("reaches %s dynamically, never statically", (impl) => {
    expect(dynamics).toContain(impl);
    expect(statics).not.toContain(impl);
  });

  it("imports nothing but types from the modules it does name statically", () => {
    const valueImports = registry
      .split("\n")
      .filter((l) => /^\s*import\s/.test(l) && !/^\s*import\s+type\s/.test(l));
    expect(valueImports).toEqual([]);
  });

  it("covers every implementation the registry can resolve", () => {
    // A kind added with an arm but left off IMPLEMENTATIONS would pass the
    // checks above by never being looked at. Pin the two lists equal instead —
    // deduplicated, because direct and plugin selections deliberately share the
    // executable adapter and differ only in cwd and declaration ownership.
    expect([...new Set(dynamics)].sort()).toEqual([...IMPLEMENTATIONS].sort());
  });
});
