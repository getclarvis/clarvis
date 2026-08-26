import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PLAN_REVIEW_ELICIT_KIND } from "@clarvis/capability";

const repoRoot = resolve(import.meta.dir, "..", "..", "..", "..");

/**
 * Files that spell the plan-review elicit kind because they cannot import it,
 * each with the declaration this test compares against `@clarvis/capability`'s.
 *
 * @remarks `@clarvis/code` depends on `@clarvis/kernel`, `@clarvis/protocol` and
 * `@clarvis/paths` only, so it can reach neither the capability contract that
 * owns the value nor the plan capability that sets it. The duplicate is
 * deliberate; this file is what stops it drifting. The test lives in
 * `@clarvis/kernel` because the kernel is the one package that both forwards the
 * kind onto the wire and can see every side of the correspondence.
 */
const DUPLICATES: readonly { file: string; declaration: RegExp }[] = [
  {
    file: "packages/code/src/adapters/elicit-types.ts",
    declaration: /export const PLAN_REVIEW_ELICIT_KIND = "([^"]+)";/,
  },
];

/**
 * Type declarations that must list the kind as a member of their elicit `kind`
 * union, so a UI branching on it is branching on a value the wire admits.
 */
const UNIONS: readonly { file: string; symbol: string }[] = [
  { file: "packages/protocol/src/runs.ts", symbol: "kind:" },
  { file: "packages/capability/src/elicit.ts", symbol: "kind?:" },
  { file: "packages/code/src/adapters/elicit-types.ts", symbol: "kind?:" },
];

describe("the plan-review elicit kind has one value across every package", () => {
  test.each(DUPLICATES.map((d) => [d.file, d.declaration] as const))(
    "%s declares the same string",
    async (file, declaration) => {
      const found = declaration.exec(await readFile(join(repoRoot, file), "utf8"));
      expect(found?.[1]).toBe(PLAN_REVIEW_ELICIT_KIND);
    },
  );

  test.each(UNIONS.map((u) => [u.file, u.symbol] as const))(
    "%s keeps it in its elicit kind union",
    async (file, symbol) => {
      const line = (await readFile(join(repoRoot, file), "utf8"))
        .split("\n")
        .find((text) => text.trimStart().startsWith(symbol) && text.includes("guard_confirm"));
      expect(line).toContain(`"${PLAN_REVIEW_ELICIT_KIND}"`);
    },
  );
});
