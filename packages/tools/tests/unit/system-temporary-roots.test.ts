import { afterEach, beforeEach, expect, it } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { systemTemporaryRoots } from "../../src/lib/system-temporary-roots.ts";
import { cleanup, makeWorkspace, write } from "../helpers/fixtures.ts";

let root: string;
beforeEach(() => {
  root = makeWorkspace();
});
afterEach(() => cleanup(root));

it("admits only existing temporary directories and deduplicates /tmp on Unix", () => {
  const unixTemp = existsSync("/tmp") && statSync("/tmp").isDirectory() ? [resolve("/tmp")] : [];
  expect(systemTemporaryRoots("linux", root)).toEqual([resolve(root), ...unixTemp]);
  expect(systemTemporaryRoots("linux", "/tmp")).toEqual(unixTemp);
  expect(systemTemporaryRoots("linux", join(root, "missing"))).toEqual(unixTemp);
  expect(systemTemporaryRoots("linux", write(root, "file.txt", "x"))).toEqual(unixTemp);
});

it("uses only the selected temporary directory on Windows", () => {
  expect(systemTemporaryRoots("win32", root)).toEqual([resolve(root)]);
});
