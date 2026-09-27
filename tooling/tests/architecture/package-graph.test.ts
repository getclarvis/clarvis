import { describe, expect, onTestFinished, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzePackageGraph as analyzePackageGraphWithArchitecture,
  checkDocument,
  parseModuleEdges,
  renderMarkdown,
} from "../../lib/package-graph.ts";

const analyzePackageGraph = (root: string) =>
  analyzePackageGraphWithArchitecture(root, { enforceArchitecture: false });

describe("parseModuleEdges", () => {
  test("recognises static, side-effect, export, type-only and dynamic edges", () => {
    const edges = parseModuleEdges(`
      import value from "@clarvis/a";
      import "@clarvis/side";
      import type { T } from "@clarvis/types";
      export { x } from "@clarvis/exported";
      export type { Y } from "@clarvis/export-types";
      export { type Z } from "@clarvis/export-specifier-type";
      import { type U } from "@clarvis/import-specifier-type";
      import alias = require("@clarvis/import-equals");
      const required = require("@clarvis/required");
      type Query = import("@clarvis/import-type").Query;
      await import("@clarvis/dynamic/subpath");
    `);
    expect(edges.map(({ specifier, kind, typeOnly }) => ({ specifier, kind, typeOnly }))).toEqual([
      { specifier: "@clarvis/a", kind: "static", typeOnly: false },
      { specifier: "@clarvis/side", kind: "static", typeOnly: false },
      { specifier: "@clarvis/types", kind: "static", typeOnly: true },
      { specifier: "@clarvis/exported", kind: "static", typeOnly: false },
      { specifier: "@clarvis/export-types", kind: "static", typeOnly: true },
      { specifier: "@clarvis/export-specifier-type", kind: "static", typeOnly: true },
      { specifier: "@clarvis/import-specifier-type", kind: "static", typeOnly: true },
      { specifier: "@clarvis/import-equals", kind: "static", typeOnly: false },
      { specifier: "@clarvis/required", kind: "static", typeOnly: false },
      { specifier: "@clarvis/import-type", kind: "static", typeOnly: true },
      { specifier: "@clarvis/dynamic/subpath", kind: "dynamic", typeOnly: false },
    ]);
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "clarvis-graph-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "packages", "a", "src"), { recursive: true });
  mkdirSync(join(root, "packages", "b", "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  writeFileSync(
    join(root, "packages", "a", "package.json"),
    JSON.stringify({
      name: "@clarvis/a",
      exports: { ".": "./src/index.ts", "./ok": "./src/ok.ts" },
      dependencies: { "@clarvis/b": "workspace:*" },
    }),
  );
  writeFileSync(
    join(root, "packages", "b", "package.json"),
    JSON.stringify({
      name: "@clarvis/b",
      exports: { ".": "./src/index.ts", "./ok": { bun: "./src/ok.ts" } },
    }),
  );
  writeFileSync(join(root, "packages", "a", "src", "index.ts"), 'import "@clarvis/b";\n');
  writeFileSync(join(root, "packages", "b", "src", "index.ts"), "export const b = 1;\n");
  writeFileSync(join(root, "packages", "b", "src", "ok.ts"), "export const ok = 1;\n");
  return root;
}

describe("analyzePackageGraph", () => {
  test("private aliases participate in module cycles and entrypoint checks", () => {
    const root = fixture();
    const dir = join(root, "packages", "a");
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    manifest.type = "module";
    manifest.imports = { "#src/*": "./src/*" };
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "src", "index.ts"), 'import "#src/one.ts";\n');
    writeFileSync(join(dir, "src", "one.ts"), 'import "./two.ts";\n');
    writeFileSync(join(dir, "src", "two.ts"), 'import "#src/one.ts";\n');
    const report = analyzePackageGraph(root);
    expect(
      report.moduleCycles.some(
        (cycle) =>
          cycle.files.some((file) => file.endsWith("one.ts")) &&
          cycle.files.some((file) => file.endsWith("two.ts")),
      ),
    ).toBe(true);
    writeFileSync(join(dir, "src", "two.ts"), 'import type { A } from "#src/index.ts";\n');
    const typeOnly = analyzePackageGraph(root);
    expect(typeOnly.moduleCycles).toEqual([]);
    expect(
      typeOnly.errors.some((error) => error.includes("source imports its own public entrypoint")),
    ).toBe(true);
  });
  test("includes stale TypeScript aliases in graph violations", () => {
    const root = fixture();
    writeFileSync(
      join(root, "packages", "a", "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          customConditions: ["bun"],
          paths: { "@clarvis/b": ["../b/src/stale.ts"] },
        },
      }),
    );
    expect(analyzePackageGraph(root).errors).toContainEqual(
      expect.stringContaining("development @clarvis/b"),
    );
  });

  test("reports a stable valid workspace graph", () => {
    const report = analyzePackageGraph(fixture());
    expect(report).toMatchObject({
      packageCount: 2,
      edgeCount: 1,
      optionalEdgeCount: 0,
      errors: [],
    });
    expect(report.packages.map((pkg) => [pkg.name, pkg.consumers])).toEqual([
      ["@clarvis/a", 0],
      ["@clarvis/b", 1],
    ]);
  });

  test("enforces runtime role policy while allowing test-only development dependencies", () => {
    const cases = [
      {
        field: "dependencies",
        tree: "src",
        source: 'import "@clarvis/loop";\n',
      },
      {
        field: "optionalDependencies",
        tree: "src",
        source: 'void import("@clarvis/loop");\n',
      },
      {
        field: "devDependencies",
        tree: "tests",
        source: 'import type { Run } from "@clarvis/loop";\n',
      },
      {
        field: "peerDependencies",
        tree: "tooling",
        source: 'export type { Run } from "@clarvis/loop";\n',
      },
    ] as const;

    for (const edge of cases) {
      const root = fixture();
      writeFileSync(
        join(root, "packages", "a", "package.json"),
        JSON.stringify({
          name: "@clarvis/code",
          exports: { ".": "./src/index.ts" },
          [edge.field]: { "@clarvis/loop": "workspace:*" },
        }),
      );
      writeFileSync(
        join(root, "packages", "b", "package.json"),
        JSON.stringify({ name: "@clarvis/loop", exports: { ".": "./src/index.ts" } }),
      );
      writeFileSync(join(root, "packages", "a", "src", "index.ts"), "export const app = 1;\n");
      mkdirSync(join(root, "packages", "a", edge.tree), { recursive: true });
      writeFileSync(join(root, "packages", "a", edge.tree, "edge.ts"), edge.source);

      const report = analyzePackageGraphWithArchitecture(root);
      const violation =
        "@clarvis/code: @clarvis/code (application) may not depend on @clarvis/loop (engine)";
      if (edge.field === "devDependencies") expect(report.errors).not.toContain(violation);
      else expect(report.errors).toContain(violation);
    }
  });

  test("detects undeclared and unexported subpaths", () => {
    const root = fixture();
    writeFileSync(join(root, "packages", "b", "src", "index.ts"), 'import "@clarvis/a/missing";\n');
    const report = analyzePackageGraph(root);
    expect(
      report.errors.some((error) => error.includes("imports undeclared dependency @clarvis/a")),
    ).toBe(true);
    expect(report.errors.some((error) => error.includes("is not exported by @clarvis/a"))).toBe(
      true,
    );
  });

  test("accepts exported deep imports and rejects private self-imports", () => {
    const root = fixture();
    writeFileSync(join(root, "packages", "a", "src", "index.ts"), 'import "@clarvis/b/ok";\n');
    expect(analyzePackageGraph(root).errors).toEqual([]);

    writeFileSync(join(root, "packages", "a", "src", "index.ts"), 'import "@clarvis/a/private";\n');
    const report = analyzePackageGraph(root);
    expect(
      report.errors.some((error) => error.includes("@clarvis/a/private is not exported")),
    ).toBe(true);
  });

  test("rejects a source import of its own public entrypoint", () => {
    const root = fixture();
    writeFileSync(join(root, "packages", "a", "src", "index.ts"), 'import "@clarvis/a";\n');
    expect(
      analyzePackageGraph(root).errors.some((error) =>
        error.includes("source imports its own public entrypoint @clarvis/a"),
      ),
    ).toBe(true);
  });

  test("detects value-import SCCs within a package and ignores type-only back edges", () => {
    const root = fixture();
    writeFileSync(join(root, "packages", "a", "src", "index.ts"), 'export * from "./one.js";\n');
    writeFileSync(join(root, "packages", "a", "src", "one.ts"), 'import "./two.js";\n');
    writeFileSync(join(root, "packages", "a", "src", "two.ts"), 'import "./one.js";\n');
    const cyclic = analyzePackageGraph(root);
    expect(cyclic.moduleCycles).toEqual([
      { package: "@clarvis/a", files: ["src/one.ts", "src/two.ts"] },
    ]);

    writeFileSync(
      join(root, "packages", "a", "src", "two.ts"),
      'import type { One } from "./one.js";\nexport const two = 2;\n',
    );
    expect(analyzePackageGraph(root).moduleCycles).toEqual([]);
  });

  test("supports wildcard exports and distinguishes type-only export conditions", () => {
    const root = fixture();
    writeFileSync(
      join(root, "packages", "b", "package.json"),
      JSON.stringify({
        name: "@clarvis/b",
        exports: {
          ".": "./src/index.ts",
          "./features/*": { bun: "./src/*.ts" },
          "./types-only": { types: "./src/ok.ts" },
        },
      }),
    );
    writeFileSync(
      join(root, "packages", "a", "src", "index.ts"),
      'import "@clarvis/b/features/ok";\nimport type { Ok } from "@clarvis/b/types-only";\n',
    );
    expect(analyzePackageGraph(root).errors).toEqual([]);

    writeFileSync(
      join(root, "packages", "a", "src", "index.ts"),
      'import "@clarvis/b/types-only";\n',
    );
    expect(
      analyzePackageGraph(root).errors.some((error) =>
        error.includes("@clarvis/b/types-only is not exported"),
      ),
    ).toBe(true);
  });

  test("separates type-only, eager, and dynamic edges and computes dynamic closure", () => {
    const root = fixture();
    writeFileSync(
      join(root, "packages", "a", "src", "index.ts"),
      'import type { B } from "@clarvis/b";\nvoid import("@clarvis/b/ok");\n',
    );
    const report = analyzePackageGraph(root);
    const a = report.packages.find((pkg) => pkg.name === "@clarvis/a");
    expect(a?.sourceEdges).toEqual({
      compilation: ["@clarvis/b"],
      eagerRuntime: [],
      dynamicRuntime: ["@clarvis/b"],
      typeOnly: ["@clarvis/b"],
    });
    expect(a?.runtimeClosure).toEqual({ eager: [], dynamic: ["@clarvis/b"] });
  });

  test("requires runtime declarations for src values but permits dev-only test and tooling imports", () => {
    const root = fixture();
    writeFileSync(
      join(root, "packages", "a", "package.json"),
      JSON.stringify({
        name: "@clarvis/a",
        exports: { ".": "./src/index.ts" },
        devDependencies: { "@clarvis/b": "workspace:*" },
      }),
    );

    expect(
      analyzePackageGraph(root).errors.some((error) =>
        error.includes("imports runtime dependency @clarvis/b"),
      ),
    ).toBe(true);

    writeFileSync(join(root, "packages", "a", "src", "index.ts"), "export const a = 1;\n");
    mkdirSync(join(root, "packages", "a", "tests"), { recursive: true });
    mkdirSync(join(root, "packages", "a", "tooling"), { recursive: true });
    writeFileSync(join(root, "packages", "a", "tests", "a.test.ts"), 'import "@clarvis/b";\n');
    writeFileSync(
      join(root, "packages", "a", "tooling", "a.ts"),
      'await import("@clarvis/b/ok");\n',
    );

    const report = analyzePackageGraph(root);
    const a = report.packages.find((pkg) => pkg.name === "@clarvis/a");
    expect(report.errors).toEqual([]);
    expect(report.edgeCount).toBe(0);
    expect(a?.sourceEdges.eagerRuntime).toEqual([]);
    expect(a?.sourceEdges.dynamicRuntime).toEqual([]);
    expect(a?.runtimeClosure).toEqual({ eager: [], dynamic: [] });
  });

  test("detects declared and compilation cycles", () => {
    const root = fixture();
    writeFileSync(
      join(root, "packages", "b", "package.json"),
      JSON.stringify({
        name: "@clarvis/b",
        exports: { ".": "./src/index.ts" },
        dependencies: { "@clarvis/a": "workspace:*" },
      }),
    );
    writeFileSync(join(root, "packages", "b", "src", "index.ts"), 'import "@clarvis/a";\n');
    const report = analyzePackageGraph(root);
    expect(report.cycles).toEqual([["@clarvis/a", "@clarvis/b"]]);
    expect(report.compilationCycles).toEqual([["@clarvis/a", "@clarvis/b"]]);
    expect(report.errors.some((error) => error.startsWith("dependency cycle:"))).toBe(true);
  });

  test("validates package and root project references, including JSONC", () => {
    const root = fixture();
    writeFileSync(
      join(root, "packages", "a", "tsconfig.build.json"),
      '{ "compilerOptions": { "composite": true, "noEmit": false, "declaration": true, "rootDir": "src", "outDir": "dist" }, "references": [{ "path": "../b/tsconfig.build.json" }] }',
    );
    writeFileSync(
      join(root, "packages", "b", "tsconfig.build.json"),
      '{ "compilerOptions": { "composite": true, "noEmit": false, "declaration": true, "rootDir": "src", "outDir": "dist" }, "references": [] }',
    );
    writeFileSync(
      join(root, "tsconfig.json"),
      '{ // solution references\n "references": [{ "path": "packages/a/tsconfig.build.json" }, { "path": "packages/b/tsconfig.build.json" }] }',
    );
    expect(analyzePackageGraph(root).errors).toEqual([]);

    writeFileSync(
      join(root, "packages", "a", "tsconfig.build.json"),
      '{ "compilerOptions": { "composite": true, "noEmit": false, "declaration": true, "rootDir": "src", "outDir": "dist" }, "references": [] }',
    );
    expect(
      analyzePackageGraph(root).errors.some((error) =>
        error.includes("dependency without project reference @clarvis/b"),
      ),
    ).toBe(true);
  });

  test("rejects relative imports that cross package roots", () => {
    const root = fixture();
    writeFileSync(
      join(root, "packages", "a", "src", "index.ts"),
      'import "../../b/src/index.ts";\n',
    );
    expect(
      analyzePackageGraph(root).errors.some((error) =>
        error.includes("relative import crosses into @clarvis/b"),
      ),
    ).toBe(true);
  });

  test("checks document metrics", () => {
    const report = analyzePackageGraph(fixture());
    const rendered = renderMarkdown(report);
    const doc = `before\n<!-- package-graph:start -->\n${rendered}\n<!-- package-graph:end -->\nafter`;
    expect(checkDocument(report, doc)).toEqual([]);
    expect(checkDocument(report, doc.replace("unclassified", "engine"))).toEqual([
      "package graph document's generated block is stale; regenerate it from renderMarkdown",
    ]);
  });
});
