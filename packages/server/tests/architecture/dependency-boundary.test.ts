import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  allowedInternalDependenciesFor,
  packageDependencyViolation,
  workspacePackageName,
} from "../../../../tooling/lib/package-architecture.ts";

const PACKAGE_NAME = "@clarvis/server";
const KERNEL_ENTRYPOINTS = new Set([
  "@clarvis/kernel",
  "@clarvis/kernel/bootstrap",
  "@clarvis/kernel/config",
  "@clarvis/kernel/policy",
]);

function importedSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/(?:from\s+|import\s*(?:\(\s*)?|require\s*\()\s*["']([^"']+)["']/g),
  ].map(([, specifier]) => specifier ?? "");
}

function typescriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? typescriptFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("server dependency boundary", () => {
  it("recognises type-only, exported, side-effect, and dynamic imports", () => {
    const namespace = "@clarvis";
    expect(
      importedSpecifiers(`
        import type { KernelClient } from "@clarvis/protocol";
        export type { RunEvent } from "@clarvis/protocol";
        import "${namespace}/tasks";
        const lazy = import("${namespace}/memory");
        type Config = import("@clarvis/kernel/config").SettingsData;
      `),
    ).toEqual([
      "@clarvis/protocol",
      "@clarvis/protocol",
      `${namespace}/tasks`,
      `${namespace}/memory`,
      "@clarvis/kernel/config",
    ]);
  });

  it("uses only owned kernel entrypoints and role-valid workspace packages", () => {
    const packageRoot = join(import.meta.dir, "../..");
    for (const file of [
      ...typescriptFiles(join(packageRoot, "src")),
      ...typescriptFiles(join(packageRoot, "tests")),
    ]) {
      const imports = importedSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of imports) {
        if (specifier.startsWith("@clarvis/kernel"))
          expect(KERNEL_ENTRYPOINTS.has(specifier)).toBe(true);
        const dependency = workspacePackageName(specifier);
        if (dependency !== undefined && dependency !== PACKAGE_NAME)
          expect(packageDependencyViolation(PACKAGE_NAME, dependency)).toBeUndefined();
      }
    }
  });

  it("derives its manifest and project references from the central role policy", () => {
    const packageRoot = join(import.meta.dir, "../..");
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const dependencies = Object.keys(manifest.dependencies)
      .filter((name) => name.startsWith("@clarvis/"))
      .sort();
    expect(dependencies).toEqual(allowedInternalDependenciesFor(PACKAGE_NAME));

    const buildConfig = JSON.parse(
      readFileSync(join(packageRoot, "tsconfig.build.json"), "utf8"),
    ) as { references: { path: string }[] };
    expect(buildConfig.references.map(({ path }) => path).sort()).toEqual(
      dependencies
        .map((dependency) => `../${dependency.slice("@clarvis/".length)}/tsconfig.build.json`)
        .sort(),
    );
  });
});
