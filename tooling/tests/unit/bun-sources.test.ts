import { describe, expect, test } from "bun:test";
import { pythonSourcePaths } from "../../checks/bun-sources.ts";

describe("pythonSourcePaths", () => {
  test("accepts Bun and TypeScript repository sources", () => {
    expect(
      pythonSourcePaths(["package.json", "scripts/check.mjs", "packages/kernel/src/index.ts"]),
    ).toEqual([]);
  });

  test("rejects every Python source extension deterministically", () => {
    expect(pythonSourcePaths(["z/helper.pyw", "a/types.PYI", "m/fixture.py", "readme.md"])).toEqual(
      ["a/types.PYI", "m/fixture.py", "z/helper.pyw"],
    );
  });
});
