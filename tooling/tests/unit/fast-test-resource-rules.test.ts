import { expect, test } from "bun:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { fastTestResourceRules } from "../../lib/fast-test-resource-rules.js";
import { clarvisEslintConfig } from "../../../eslint.config.base.js";

const linter = new Linter();
function violations(source: string, physical = false): string[] {
  return linter
    .verify(source, [
      {
        languageOptions: { parser: tseslint.parser },
        rules: physical ? {} : fastTestResourceRules,
      },
    ])
    .map((message) => message.ruleId ?? "parser");
}

test("fast resource rules reject direct filesystem, process and global mutations", () => {
  expect(violations('import { mkdtemp } from "node:fs/promises";')).toContain(
    "no-restricted-imports",
  );
  expect(violations('Bun.spawn(["fixture"]);')).toContain("no-restricted-syntax");
  expect(violations('process.env.CLARVIS_HOME = "fixture";')).toContain("no-restricted-syntax");
  expect(violations("delete process.env.CLARVIS_HOME;")).toContain("no-restricted-syntax");
  expect(violations("globalThis.fetch = fakeFetch;")).toContain("no-restricted-syntax");
  expect(violations('vi.stubGlobal("fetch", fakeFetch);')).toContain("no-restricted-syntax");
  expect(violations('spyOn(process, "emitWarning");')).toContain("no-restricted-syntax");
  expect(violations('vi.spyOn(process.stderr, "write");')).toContain("no-restricted-syntax");
});

test("type-only imports and physical integration sources remain eligible", () => {
  expect(violations('import type { Stats } from "node:fs";')).toEqual([]);
  expect(violations('import { join } from "node:path";')).toEqual([]);
  expect(violations('import { mkdtemp } from "node:fs/promises";', true)).toEqual([]);
  const policy = clarvisEslintConfig({ tsconfigRootDir: import.meta.dir }).find(
    (config) =>
      config.rules?.["no-restricted-imports"] === fastTestResourceRules["no-restricted-imports"],
  );
  expect(policy?.files).toContain("tests/unit/**/*.{ts,tsx}");
  expect(policy?.files).not.toContain("tests/integration/**/*.{ts,tsx}");
});
