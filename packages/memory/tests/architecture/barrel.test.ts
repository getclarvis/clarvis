import { describe, expect, test } from "bun:test";

import { sanitizeText } from "@clarvis/capability";

import * as barrel from "../../src/index.ts";

// The barrel's redaction surface is an invisible property: re-adding
// `sanitizeDeep` here — or widening the re-export to `export * from
// "@clarvis/capability"` — restores a weaker default under memory's name with a
// green typecheck, a green lint and a green suite. `sanitizeDeep` defaults to
// the replay-safe tool-payload rules, which match the generic secret words only
// when quoted, so a one-argument call reached through this barrel redacts
// strictly less than the wiki's own rules do.
describe("the package barrel's redaction surface", () => {
  test("republishes sanitizeText and deliberately not sanitizeDeep", () => {
    expect("sanitizeText" in barrel).toBe(true);
    expect("sanitizeDeep" in barrel).toBe(false);
  });

  test("republishes the contract's own redactor rather than a local copy", () => {
    expect(barrel.sanitizeText).toBe(sanitizeText);
  });
});
