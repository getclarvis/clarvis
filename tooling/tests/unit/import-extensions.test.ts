import { describe, expect, test } from "bun:test";
import {
  invalidRelativeImportExtensions,
  moduleSpecifiers,
  typescriptSourcePaths,
} from "../../checks/import-extensions.ts";

describe("moduleSpecifiers", () => {
  test("collects every supported static, dynamic, export, require, and type position", () => {
    const source = `
      import value from "./value.js";
      import type { Shape } from "./shape.js";
      export { item } from "./item.js";
      export type { Kind } from "./kind.js";
      import legacy = require("./legacy.cjs");
      type Lazy = import("./lazy.js").Lazy;
      const dynamic = import("./dynamic.js");
      const required = require("./required.js");
    `;

    expect(moduleSpecifiers("fixture.ts", source)).toEqual([
      "./value.js",
      "./shape.js",
      "./item.js",
      "./kind.js",
      "./legacy.cjs",
      "./lazy.js",
      "./dynamic.js",
      "./required.js",
    ]);
  });

  test("does not treat examples in comments or ordinary strings as imports", () => {
    expect(
      moduleSpecifiers(
        "fixture.ts",
        `const example = 'import("./not-an-import.js")'; // from "./also-not.js"`,
      ),
    ).toEqual([]);
  });
});

describe("invalidRelativeImportExtensions", () => {
  const existing = new Set([
    "/repo/shared/shared.ts",
    "/repo/src/value.ts",
    "/repo/src/view.tsx",
    "/repo/src/module.mts",
    "/repo/src/legacy.cts",
    "/repo/src/runtime.js",
  ]);
  const fileExists = (path: string) => existing.has(path);

  test("reports runtime extensions that alias TypeScript sources", () => {
    const source = `
      import "./value.js";
      import "../shared/shared.js";
      export { View } from "./view.js";
      const module = import("./module.mjs");
      type Legacy = import("./legacy.cjs").Legacy;
    `;

    expect(invalidRelativeImportExtensions("/repo/src/entry.ts", source, fileExists)).toEqual([
      { file: "/repo/src/entry.ts", specifier: "./value.js", expected: "./value.ts" },
      {
        file: "/repo/src/entry.ts",
        specifier: "../shared/shared.js",
        expected: "../shared/shared.ts",
      },
      { file: "/repo/src/entry.ts", specifier: "./view.js", expected: "./view.tsx" },
      { file: "/repo/src/entry.ts", specifier: "./module.mjs", expected: "./module.mts" },
      { file: "/repo/src/entry.ts", specifier: "./legacy.cjs", expected: "./legacy.cts" },
    ]);
  });

  test("preserves real JavaScript artifacts and external package specifiers", () => {
    const source = `
      import "./runtime.js";
      import "dependency/runtime.js";
    `;

    expect(invalidRelativeImportExtensions("/repo/src/entry.ts", source, fileExists)).toEqual([]);
  });

  test("reports extensionless literals in every supported AST position", () => {
    const source = `
      import "./value";
      import type { View } from "./view";
      export type { Legacy } from "./legacy";
      import alias = require("./module");
      type Shape = import("./unknown").Shape;
      const dynamic = import("./directory");
      const common = require("./value");
      // import "./comment"
      const example = 'import("./example")';
    `;
    const exists = new Set([...existing, "/repo/src/directory/index.ts"]);
    expect(
      invalidRelativeImportExtensions("/repo/src/entry.ts", source, (path: string) =>
        exists.has(path),
      ),
    ).toEqual([
      { file: "/repo/src/entry.ts", specifier: "./value", expected: "./value.ts" },
      { file: "/repo/src/entry.ts", specifier: "./view", expected: "./view.tsx" },
      { file: "/repo/src/entry.ts", specifier: "./legacy", expected: "./legacy.cts" },
      { file: "/repo/src/entry.ts", specifier: "./module", expected: "./module.mts" },
      { file: "/repo/src/entry.ts", specifier: "./unknown", expected: undefined },
      { file: "/repo/src/entry.ts", specifier: "./directory", expected: "./directory/index.ts" },
      { file: "/repo/src/entry.ts", specifier: "./value", expected: "./value.ts" },
    ]);
  });

  test("does not invent a suggestion for ambiguous or non-TypeScript targets", () => {
    const exists = new Set([...existing, "/repo/src/value.tsx", "/repo/src/config.json"]);
    expect(
      invalidRelativeImportExtensions(
        "/repo/src/entry.ts",
        'import "./value"; import "./config.json"; import "./runtime.js";',
        (path: string) => exists.has(path),
      ),
    ).toEqual([{ file: "/repo/src/entry.ts", specifier: "./value", expected: undefined }]);
  });
});

test("typescriptSourcePaths is sorted and excludes JavaScript artifacts", () => {
  expect(
    typescriptSourcePaths(["z.tsx", "runtime.js", "a.cts", "types.d.ts", "module.mts"]),
  ).toEqual(["a.cts", "module.mts", "types.d.ts", "z.tsx"]);
});
