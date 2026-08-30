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
  it("releases durable memory recovery only after the usable application paint", () => {
    const source = readFileSync(join(SRC, "runtime.tsx"), "utf8");
    const painted = source.indexOf('"app.boot.painted"');
    const recovery = source.indexOf("workspaceManager.startMemoryRecovery()");
    expect(painted).toBeGreaterThanOrEqual(0);
    expect(recovery).toBeGreaterThan(painted);
  });

  it("starts a task queued in the startup composer before complete-app hydration", () => {
    const source = readFileSync(join(SRC, "runtime.tsx"), "utf8");
    const submission = source.indexOf('detachObserved("startup_submit"');
    const appMount = source.indexOf('diagnosticAsync("boot.app-mount"');
    expect(submission).toBeGreaterThanOrEqual(0);
    expect(appMount).toBeGreaterThan(submission);
  });

  it("does not resume profile boot after the fatal renderer is destroyed", () => {
    const source = readFileSync(join(SRC, "runtime.tsx"), "utf8");
    const fatalBoot = source.indexOf("const recovered = await runFatalBoot");
    const terminalGuard = source.indexOf("if (!recovered) return", fatalBoot);
    const profiles = source.indexOf("const bootProfiles = await", fatalBoot);
    expect(fatalBoot).toBeGreaterThanOrEqual(0);
    expect(terminalGuard).toBeGreaterThan(fatalBoot);
    expect(profiles).toBeGreaterThan(terminalGuard);
  });

  it("does not admit startup work after shutdown begins during boot", () => {
    const source = readFileSync(join(SRC, "runtime.tsx"), "utf8");
    const latch = source.indexOf("bootShutdownRequested = true");
    const profiles = source.indexOf("const bootProfiles = await");
    const guard = source.indexOf("if (bootShutdownRequested) return", profiles);
    const submission = source.indexOf('detachObserved("startup_submit"');
    expect(latch).toBeGreaterThanOrEqual(0);
    expect(profiles).toBeGreaterThan(latch);
    expect(guard).toBeGreaterThan(profiles);
    expect(submission).toBeGreaterThan(guard);
  });

  it("retains bootstrap Ctrl+C ownership through complete-app mount", () => {
    const source = readFileSync(join(SRC, "runtime.tsx"), "utf8");
    const appMount = source.indexOf('diagnosticAsync("boot.app-mount"');
    const release = source.indexOf("releaseBootRendererLifecycle()", appMount);
    expect(appMount).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(appMount);
  });

  it("installs renderer teardown before any later bootstrap owner", () => {
    const source = readFileSync(join(SRC, "index.tsx"), "utf8");
    const renderer = source.indexOf("const renderer = await createCliRenderer");
    const lifecycle = source.indexOf("const rendererLifecycle = installBootRendererLifecycle");
    const terminal = source.indexOf("const releaseTerminal = installTerminalGuard");
    expect(renderer).toBeGreaterThanOrEqual(0);
    expect(lifecycle).toBeGreaterThan(renderer);
    expect(terminal).toBeGreaterThan(lifecycle);
  });

  it("confines concrete kernel imports to composition and adapter boundaries", () => {
    const offenders = sourceFiles(SRC).flatMap((file) => {
      const relativeFile = relative(SRC, file).split(sep).join("/");
      if (
        relativeFile === "index.tsx" ||
        relativeFile === "runtime.tsx" ||
        relativeFile === "startup-foundation.ts" ||
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
