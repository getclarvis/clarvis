import { describe, expect, test } from "bun:test";
import { findModuleMockCalls, findUnclassifiedTestFiles } from "../../lib/source-policy.ts";

const moduleCall = (prefix = ""): string => `${prefix}${"mock"}.${"module"}("pkg", () => ({}));`;

describe("findModuleMockCalls", () => {
  test("finds direct, awaited, and voided module replacements with source locations", () => {
    const source = [moduleCall(), moduleCall("await "), moduleCall("void ")].join("\n");

    expect(findModuleMockCalls("fixture.ts", source)).toEqual([
      { file: "fixture.ts", line: 1, column: 1 },
      { file: "fixture.ts", line: 2, column: 7 },
      { file: "fixture.ts", line: 3, column: 6 },
    ]);
  });

  test("ignores comments, strings, other objects, and a non-call property read", () => {
    const spelling = `${"mock"}.${"module"}`;
    const source = [
      `// ${spelling}("comment")`,
      `const text = ${JSON.stringify(`${spelling}("string")`)};`,
      `other.module("pkg")`,
      spelling,
    ].join("\n");

    expect(findModuleMockCalls("fixture.ts", source)).toEqual([]);
  });
});

describe("findUnclassifiedTestFiles", () => {
  test("accepts explicit levels and rejects flat or helper test files", () => {
    expect(
      findUnclassifiedTestFiles([
        "packages/a/tests/unit/policy.test.ts",
        "packages/a/tests/integration/wire.test.tsx",
        "packages/a/tests/e2e/artifact.test.mts",
        "packages/a/tests/helpers/builders.ts",
        "packages/a/tests/flat.test.ts",
        "packages/a/tests/helpers/hidden.test.ts",
      ]),
    ).toEqual(["packages/a/tests/flat.test.ts", "packages/a/tests/helpers/hidden.test.ts"]);
  });

  /**
   * Bun collects four filename shapes, and the classifier used to know one.
   * Verified on the pinned Bun 1.3.11 that a `.spec.ts` and a `_test.ts` under
   * `tests/helpers/` are both collected and run — so before this, a test could
   * sit outside every declared level, execute on every CI leg, and be reported
   * by nothing at all.
   */
  test.each([
    "packages/a/tests/helpers/thing.spec.ts",
    "packages/a/tests/helpers/thing_test.ts",
    "packages/a/tests/helpers/thing_spec.ts",
    "packages/a/tests/helpers/thing.spec.tsx",
    "packages/a/tests/helpers/thing.spec.mts",
  ])("reports %s, which Bun runs and the old matcher ignored", (file) => {
    expect(findUnclassifiedTestFiles([file])).toEqual([file]);
  });

  test.each(["packages/a/tests/unit/thing.spec.ts", "packages/a/tests/integration/thing_test.ts"])(
    "accepts %s, since the level is what it is judged on",
    (file) => {
      expect(findUnclassifiedTestFiles([file])).toEqual([]);
    },
  );

  test("still leaves a plain helper alone, whatever it is called", () => {
    expect(
      findUnclassifiedTestFiles([
        "packages/a/tests/helpers/builders.ts",
        "packages/a/tests/helpers/specimen.ts",
        "packages/a/tests/helpers/testing.ts",
        "packages/a/tests/helpers/latest.ts",
      ]),
    ).toEqual([]);
  });

  test("normalizes Windows paths", () => {
    expect(
      findUnclassifiedTestFiles([
        "packages\\a\\tests\\architecture\\surface.test.ts",
        "packages\\a\\tests\\surface.test.ts",
      ]),
    ).toEqual(["packages\\a\\tests\\surface.test.ts"]);
  });
});
