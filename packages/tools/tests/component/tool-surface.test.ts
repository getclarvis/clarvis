/**
 * The advertised surface has one size, written down once.
 *
 * @remarks `tests/component/core.test.ts` proves the registry equals the oracle
 * in `tests/helpers/tool-surface.js`; this file proves the oracle is the size it
 * claims and that the dispatcher agrees. Deriving a count from the oracle would
 * assert nothing — it would restate the equality the other file already owns —
 * so the numbers here are literal on purpose, and growing the surface has to
 * edit them.
 *
 * It replaces `tests/component/syntax-absent.test.ts`, which held the same two
 * numbers for a surface that could still shrink at runtime when the optional
 * tree-sitter peer failed to load. It cannot any more: there is no conditional
 * surface left, which is why the removed names are asserted absent from both.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dispatch, listTools } from "../../src/core.ts";
import { cleanup, makeConfig, makeWorkspace, resultText } from "../helpers/fixtures.ts";
import { EXPECTED_TOOL_DESCRIPTORS, expectedToolNames } from "../helpers/tool-surface.ts";

/** Names that left with tree-sitter, spelled out so a re-add is deliberate. */
const REMOVED = ["outline", "check_syntax"] as const;

describe("the advertised tool surface", () => {
  let root: string;

  beforeEach(() => {
    root = makeWorkspace();
  });
  afterEach(() => cleanup(root));

  it("is 24 coding tools, 9 of them read-only, on every config", () => {
    expect(EXPECTED_TOOL_DESCRIPTORS).toHaveLength(24);
    expect(expectedToolNames({ readOnly: true })).toHaveLength(9);
    expect(listTools(makeConfig(root)).map(({ name }) => name)).toEqual(
      expectedToolNames({ readOnly: false }),
    );
    expect(listTools(makeConfig(root, { readOnly: true })).map(({ name }) => name)).toEqual(
      expectedToolNames({ readOnly: true }),
    );
  });

  it("advertises no syntax tool on either surface", () => {
    const full = listTools(makeConfig(root)).map(({ name }) => name);
    const readOnly = listTools(makeConfig(root, { readOnly: true })).map(({ name }) => name);
    for (const gone of REMOVED) {
      expect(full, gone).not.toContain(gone);
      expect(readOnly, gone).not.toContain(gone);
    }
  });

  it("refuses a removed tool exactly as it refuses a typo", async () => {
    const config = makeConfig(root);
    for (const gone of [...REMOVED, "does_not_exist"]) {
      const result = await dispatch(gone, { path: "a.ts" }, config);
      expect(result.isError, gone).toBe(true);
      expect(JSON.parse(resultText(result.content)), gone).toEqual({
        error: "not_found",
        message: `Unknown tool: ${gone}`,
      });
    }
  });

  it("tells the model nothing about a runtime it could try to install", async () => {
    const result = await dispatch("outline", { path: "a.ts" }, makeConfig(root));
    const text = resultText(result.content).toLowerCase();
    for (const hint of ["tree", "sitter", "unavailable", "disabled", "install", "degraded"]) {
      expect(text, hint).not.toContain(hint);
    }
  });
});
