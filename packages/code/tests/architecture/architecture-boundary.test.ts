import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const SRC = join(import.meta.dir, "..", "..", "src");

interface ImportEdge {
  file: string;
  specifier: string;
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = join(root, entry.name);
    return entry.isDirectory()
      ? sourceFiles(file)
      : /\.[cm]?[jt]sx?$/.test(entry.name)
        ? [file]
        : [];
  });
}

function specifiersIn(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
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
  visit(source);
  return found;
}

function edgesUnder(layer: string): ImportEdge[] {
  const root = join(SRC, layer);
  return sourceFiles(root).flatMap((file) =>
    specifiersIn(file).map((specifier) => ({
      file: relative(SRC, file).split(sep).join("/"),
      specifier,
    })),
  );
}

function relativeLayer(edge: ImportEdge): string | undefined {
  if (!edge.specifier.startsWith(".")) return undefined;
  const target = resolve(SRC, dirname(edge.file), edge.specifier);
  const rel = relative(SRC, target);
  if (rel.startsWith("..")) return undefined;
  return rel.split(sep)[0];
}

describe("code's internal architecture", () => {
  it("confines concrete kernel imports to composition and adapter boundaries", () => {
    const offenders = sourceFiles(SRC).flatMap((file) => {
      const relativeFile = relative(SRC, file).split(sep).join("/");
      if (
        relativeFile === "index.tsx" ||
        relativeFile.startsWith("bootstrap/") ||
        relativeFile.startsWith("adapters/")
      )
        return [];
      return specifiersIn(file)
        .filter((specifier) => specifier.startsWith("@clarvis/kernel"))
        .map((specifier) => ({ file: relativeFile, specifier }));
    });
    expect(offenders).toEqual([]);
  });

  it("keeps core framework-free and independent from adapters and presentation", () => {
    const offenders = edgesUnder("core").filter((edge) => {
      const layer = relativeLayer(edge);
      return (
        edge.specifier === "solid-js" ||
        edge.specifier.startsWith("@opentui/") ||
        edge.specifier.startsWith("@clarvis/kernel") ||
        edge.specifier === "@clarvis/paths" ||
        edge.specifier === "node:fs" ||
        edge.specifier === "node:fs/promises" ||
        layer === "adapters" ||
        layer === "theme" ||
        layer === "ui" ||
        layer === "views"
      );
    });
    expect(offenders).toEqual([]);
  });

  it("keeps the adapters layer independent from presentation", () => {
    const offenders = edgesUnder("adapters").filter((edge) => {
      const layer = relativeLayer(edge);
      return layer === "ui" || layer === "views";
    });
    expect(offenders).toEqual([]);
  });

  it("keeps generic UI independent from kernel services and feature implementations", () => {
    const offenders = edgesUnder("ui").filter((edge) => {
      const layer = relativeLayer(edge);
      return (
        edge.specifier.startsWith("@clarvis/kernel") || layer === "adapters" || layer === "features"
      );
    });
    expect(offenders).toEqual([]);
  });

  it("keeps feature controllers independent from presentation", () => {
    const controllers = edgesUnder("features").filter(
      (edge) =>
        edge.file.endsWith("/controller.ts") &&
        (relativeLayer(edge) === "theme" ||
          relativeLayer(edge) === "ui" ||
          relativeLayer(edge) === "views" ||
          edge.specifier.endsWith(".tsx")),
    );
    expect(controllers).toEqual([]);
  });

  it("counts relative and type-only imports when enforcing a layer", () => {
    const source = ts.createSourceFile(
      "fixture.ts",
      'import type { HintTone } from "../views/hint.ts";',
      ts.ScriptTarget.Latest,
      true,
    );
    const declaration = source.statements[0];
    if (!declaration) throw new Error("fixture did not produce an import declaration");
    expect(ts.isImportDeclaration(declaration)).toBe(true);
    expect(
      ts.isImportDeclaration(declaration)
        ? (declaration.moduleSpecifier as ts.StringLiteral).text
        : undefined,
    ).toBe("../views/hint.ts");
  });
});
