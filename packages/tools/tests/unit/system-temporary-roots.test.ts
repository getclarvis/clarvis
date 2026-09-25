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
  expect(systemTemporaryRoots(root)).toEqual([resolve(root), ...unixTemp]);
  expect(systemTemporaryRoots("/tmp")).toEqual(unixTemp);
  expect(systemTemporaryRoots(join(root, "missing"))).toEqual(unixTemp);
  expect(systemTemporaryRoots(write(root, "file.txt", "x"))).toEqual(unixTemp);
});
