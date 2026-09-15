import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const srcRoot = join(import.meta.dir, "..", "..", "src");

/**
 * The modules `src/cli.ts` may reach *statically*.
 *
 * @remarks Everything in this closure is evaluated before `--version` can print
 * one string. It used to be the whole application — 847 files, ~2.5 s — because
 * the flag was handled inside `main()`. Keeping the set this small is the fix.
 */
const ALLOWED = new Set([
  "../../package.json",
  "src/cli.ts",
  "src/cli-args.ts",
  "src/cli-entry.ts",
]);

/** Specifiers the launcher must reach only through a dynamic `import()`. */
const MUST_BE_DYNAMIC = [
  "@opentui/solid/preload",
  "./index.tsx",
  "./remote-host.ts",
  "./update/index.ts",
];

interface Specifier {
  text: string;
  dynamic: boolean;
  typeOnly: boolean;
}

function specifiersIn(source: string): Specifier[] {
  const file = ts.createSourceFile("cli.ts", source, ts.ScriptTarget.Latest, true);
  const found: Specifier[] = [];
  const push = (node: ts.Expression | undefined, dynamic: boolean, typeOnly: boolean): void => {
    if (node && ts.isStringLiteralLike(node)) found.push({ text: node.text, dynamic, typeOnly });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      push(node.moduleSpecifier, false, node.importClause?.isTypeOnly === true);
    } else if (ts.isExportDeclaration(node)) {
      push(node.moduleSpecifier, false, node.isTypeOnly);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      push(node.arguments[0], true, false);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      push(node.argument.literal, false, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function resolveRelative(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const target = resolve(dirname(fromFile), specifier);
  for (const candidate of [target, `${target}.ts`, `${target}.tsx`, join(target, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function relativeToPackage(file: string): string {
  return relative(join(import.meta.dir, "..", ".."), file).replaceAll("\\", "/");
}

/** Walk the static, value-carrying import graph from `src/cli.ts`. */
function staticClosure(): Set<string> {
  const entry = join(srcRoot, "cli.ts");
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    const key = relativeToPackage(file);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const specifier of specifiersIn(readFileSync(file, "utf8"))) {
      if (specifier.dynamic || specifier.typeOnly) continue;
      const next = resolveRelative(file, specifier.text);
      if (next !== undefined) queue.push(next);
    }
  }
  return seen;
}

describe("cli fast path", () => {
  it("publishes only the clarvis command and gives installation its map-free build", () => {
    const packageRoot = join(import.meta.dir, "..", "..");
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const setup = readFileSync(join(packageRoot, "tooling", "setup.ts"), "utf8");
    expect(manifest.bin).toEqual({ clarvis: "src/cli.ts" });
    expect(manifest.scripts?.setup).toBe("bun run tooling/setup.ts");
    expect(manifest.scripts?.["build:install"]).toBe("bun run tooling/artifact/build.ts --install");
    expect(setup).toContain('join(repositoryRoot, "mise.toml")');
    expect(setup).toContain("Bun.version !== expected");
    expect(setup).toContain('["bun", "install", "--frozen-lockfile"]');
    expect(setup).toContain('["bun", "--filter", "@clarvis/code", "build:install"]');
    expect(setup).toContain("isSymbolicLink");
    expect(setup).toContain("resolvedTarget !== ownedTarget");
    expect(setup).toMatch(/"global",\s*"node_modules",\s*"@clarvis",\s*"code"/);
    expect(setup).not.toMatch(/bun@latest|curl|\.bashrc|\.zshrc|\.profile/);
  });

  it("reaches nothing beyond the argument modules before printing --version", () => {
    expect([...staticClosure()].sort()).toEqual([...ALLOWED].sort());
  });

  it("loads the application only through a dynamic import", () => {
    const specifiers = specifiersIn(readFileSync(join(srcRoot, "cli.ts"), "utf8"));
    for (const target of MUST_BE_DYNAMIC) {
      const uses = specifiers.filter((s) => s.text === target);
      expect(uses.length).toBeGreaterThan(0);
      for (const use of uses) expect(use.dynamic).toBe(true);
    }
  });

  it("keeps cli-args.ts free of every runtime import but the root product manifest", () => {
    const specifiers = specifiersIn(readFileSync(join(srcRoot, "cli-args.ts"), "utf8"));
    const runtime = specifiers.filter((s) => !s.typeOnly && !s.dynamic).map((s) => s.text);
    expect(runtime).toEqual(["../../../package.json"]);
  });

  it("recognises the import forms it is asked to distinguish", () => {
    const sample = specifiersIn(
      [
        `import a from "./value.ts";`,
        `import type { T } from "./type.ts";`,
        `const m = await import("./dynamic.ts");`,
      ].join("\n"),
    );
    expect(sample).toEqual([
      { text: "./value.ts", dynamic: false, typeOnly: false },
      { text: "./type.ts", dynamic: false, typeOnly: true },
      { text: "./dynamic.ts", dynamic: true, typeOnly: false },
    ]);
  });
});
