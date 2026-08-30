import { expect, test } from "bun:test";
import {
  assertRuntimePackageRoot,
  runtimePackageCandidates,
  runtimePackageName,
} from "../../tooling/release/runtime-package-discovery.ts";

test("runtime package names retain only the package root", () => {
  expect(runtimePackageName("ajv")).toBe("ajv");
  expect(runtimePackageName("zod/v4/core")).toBe("zod");
  expect(runtimePackageName("@opentui/core")).toBe("@opentui/core");
  expect(runtimePackageName("@opentui/core/testing")).toBe("@opentui/core");
});

test("runtime package names reject paths, builtins, and internal imports", () => {
  for (const specifier of [
    "",
    ".",
    "..",
    "./local.ts",
    "../local.ts",
    "/",
    "/absolute/file.ts",
    String.raw`C:\absolute\file.ts`,
    String.raw`\\server\share\file.ts`,
    "node:fs",
    "bun:test",
    "#internal",
    "package#fragment",
    "@scope",
    "@/package",
    "@scope/",
    String.raw`@scope\package`,
    String.raw`@scope/package\file.ts`,
  ]) {
    expect(runtimePackageName(specifier)).toBeUndefined();
  }
});

test("runtime closure entries must already be exact package roots", () => {
  expect(() => assertRuntimePackageRoot("ajv")).not.toThrow();
  expect(() => assertRuntimePackageRoot("@opentui/core")).not.toThrow();
  expect(() => assertRuntimePackageRoot("zod/v4")).toThrow(
    'invalid runtime package name: "zod/v4"',
  );
  expect(() => assertRuntimePackageRoot("/")).toThrow('invalid runtime package name: "/"');
});

test("artifact discovery keeps static and called packages while ignoring path-like specifiers", () => {
  const source = [
    'import { pino } from "pino"',
    'import "side-effect-package/register"',
    'export { value } from "@scope/exported/subpath"',
    'import local from "./local.ts"',
    'export { readFile } from "node:fs"',
    'const Ajv = createRequire(import.meta.url)("ajv")',
    'const ignore = createRequire(import.meta.url)("ignore/subpath")',
    'const bundled = co(import.meta.url)("aliased-create-require/subpath")',
    'const zod = load("zod/v4")',
    'const relative = createRequire(import.meta.url)(".")',
    'const root = createRequire(import.meta.url)("/")',
    String.raw`const drive = createRequire(import.meta.url)("C:\absolute\file.ts")`,
    'const builtin = createRequire(import.meta.url)("node:fs")',
  ].join("\n");

  expect(runtimePackageCandidates(source)).toEqual([
    "@scope/exported",
    "ajv",
    "aliased-create-require",
    "ignore",
    "pino",
    "side-effect-package",
    "zod",
  ]);
});
