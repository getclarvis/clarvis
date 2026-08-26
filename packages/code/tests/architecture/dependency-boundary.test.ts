import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";
import {
  allowedInternalDependenciesFor,
  packageDependencyViolation,
  workspacePackageName,
} from "../../../../tooling/lib/package-architecture.ts";

const PACKAGE_NAME = "@clarvis/code";
const KERNEL_ENTRYPOINTS = new Set([
  "@clarvis/kernel",
  "@clarvis/kernel/bootstrap",
  "@clarvis/kernel/config",
  "@clarvis/kernel/policy",
  "@clarvis/kernel/local",
]);

function importedSpecifiers(source: string): string[] {
  const file = ts.createSourceFile("boundary.ts", source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const add = (node: ts.Expression | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) found.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
      else if (ts.isIdentifier(node.expression) && node.expression.text === "require")
        add(node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("code dependency boundary", () => {
  it("recognises type-only, exported, side-effect, and dynamic imports", () => {
    expect(
      importedSpecifiers(`
        import type { KernelClient } from "@clarvis/protocol";
        export type { RunEvent } from "@clarvis/protocol";
        import "@clarvis/kernel/policy";
        const lazy = import("@clarvis/kernel/config");
        type Config = import("@clarvis/kernel/config").SettingsData;
      `),
    ).toEqual([
      "@clarvis/protocol",
      "@clarvis/protocol",
      "@clarvis/kernel/policy",
      "@clarvis/kernel/config",
      "@clarvis/kernel/config",
    ]);
  });

  it("uses only owned kernel entrypoints and role-valid workspace packages", () => {
    const packageRoot = join(import.meta.dir, "..", "..");
    for (const file of [
      ...sourceFiles(join(packageRoot, "src")),
      ...sourceFiles(join(import.meta.dir, "..")),
    ]) {
      for (const specifier of importedSpecifiers(readFileSync(file, "utf8"))) {
        if (specifier.startsWith("@clarvis/kernel"))
          expect(KERNEL_ENTRYPOINTS.has(specifier)).toBe(true);
        const dependency = workspacePackageName(specifier);
        if (dependency !== undefined && dependency !== PACKAGE_NAME)
          expect(packageDependencyViolation(PACKAGE_NAME, dependency)).toBeUndefined();
      }
    }
  });

  it("derives its exact Clarvis manifest allowlist from the central role policy", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(
      Object.keys(manifest.dependencies)
        .filter((name) => name.startsWith("@clarvis/"))
        .sort(),
    ).toEqual(allowedInternalDependenciesFor(PACKAGE_NAME));
  });
});
