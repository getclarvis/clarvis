import { Glob } from "bun";
import { describe, expect, it } from "../bun-test.ts";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import ts from "typescript";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const REMOVED = ["@clarvis/loop", "internal"].join("/");
const SOURCE_GLOB = "packages/*/{src,tests,scripts}/**/*.{ts,tsx,js,jsx,mjs,cjs}";

interface ImportSite {
  file: string;
  line: number;
  specifier: string;
}

function moduleSpecifiers(file: string): ImportSite[] {
  const extension = extname(file);
  const kind =
    extension === ".tsx"
      ? ts.ScriptKind.TSX
      : extension === ".jsx"
        ? ts.ScriptKind.JSX
        : extension === ".js" || extension === ".mjs" || extension === ".cjs"
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const sites: ImportSite[] = [];
  const add = (node: ts.Expression | undefined, owner: ts.Node): void => {
    if (!node || !ts.isStringLiteralLike(node)) return;
    const position = source.getLineAndCharacterOfPosition(owner.getStart(source));
    sites.push({
      file: relative(REPO, file).split(sep).join("/"),
      line: position.line + 1,
      specifier: node.text,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier, node);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression, node);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0], node);
      else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        add(node.arguments[0], node);
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

function removedImports(): { sites: ImportSite[]; scanned: number } {
  const sites: ImportSite[] = [];
  let scanned = 0;
  for (const match of new Glob(SOURCE_GLOB).scanSync({ cwd: REPO })) {
    scanned += 1;
    for (const site of moduleSpecifiers(join(REPO, match))) {
      if (site.specifier === REMOVED || site.specifier.startsWith(`${REMOVED}/`)) sites.push(site);
    }
  }
  return { sites, scanned };
}

describe("the removed loop internal entrypoint", () => {
  it("is absent from the export map and source tree", () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO, "packages", "loop", "package.json"), "utf8"),
    ) as { exports?: Record<string, unknown> };
    expect(manifest.exports?.["./internal"]).toBeUndefined();
    expect(existsSync(join(REPO, "packages", "loop", "src", "internal.ts"))).toBe(false);
  });

  it("is not imported from any package source, test, or script", () => {
    const result = removedImports();
    expect(result.scanned).toBeGreaterThan(100);
    expect(result.sites).toEqual([]);
  });

  it("recognises static, exported, dynamic, and type-position references", () => {
    const source = [
      `import type { A } from "${REMOVED}";`,
      `export { B } from "${REMOVED}";`,
      `void import("${REMOVED}/deep");`,
      `type C = import("${REMOVED}").C;`,
    ].join("\n");
    const fixture = join(REPO, "fixture.ts");
    const parsed = ts.createSourceFile(fixture, source, ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        found.push(node.moduleSpecifier.text);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        found.push(node.arguments[0].text);
      } else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      ) {
        found.push(node.argument.literal.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    expect(found).toEqual([REMOVED, REMOVED, `${REMOVED}/deep`, REMOVED]);
  });
});
