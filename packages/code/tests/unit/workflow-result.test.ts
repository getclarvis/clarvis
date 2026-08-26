import { expect, test } from "bun:test";
import {
  formatStructuredWorkflowResult,
  parseStructuredWorkflowResult,
} from "../../src/views/config/workflow-result.ts";

test("JSON workflow strings become scannable Markdown without dropping nested fields", () => {
  const parsed = parseStructuredWorkflowResult(
    JSON.stringify({
      scope: "Full workspace audit",
      findings: [
        {
          id: "F01",
          title: "Event triggers all valid",
          claim: "Every trigger points to a known event",
          evidence: ["js/narrative.js:110", "test/game.test.js:650"],
          needs_verification: false,
        },
      ],
      coverage_gaps: ["Did not run the test suite"],
    }),
  );

  expect(parsed).toBeDefined();
  const result = formatStructuredWorkflowResult(parsed!);
  expect(result).toContain("**Structured result**");
  expect(result).toContain("- **Scope:** Full workspace audit");
  expect(result).toContain("## Findings");
  expect(result).toContain("### 1. Event triggers all valid");
  expect(result).toContain("- **ID:** F01");
  expect(result).toContain("#### Evidence");
  expect(result).toContain("- js/narrative.js:110");
  expect(result).toContain("- **Needs verification:** false");
  expect(result).toContain("## Coverage gaps");
});

test("ordinary prose and scalar JSON strings are not reinterpreted as structured output", () => {
  expect(parseStructuredWorkflowResult("All checks passed.")).toBeUndefined();
  expect(parseStructuredWorkflowResult('"All checks passed."')).toBeUndefined();
  expect(parseStructuredWorkflowResult("{not valid JSON}")).toBeUndefined();
});

test("cyclic direct objects fail explicitly instead of recursing forever", () => {
  const value: Record<string, unknown> = {};
  value.self = value;
  expect(() => formatStructuredWorkflowResult(value)).toThrow("cyclic workflow result");
});

test("nested arrays and schema-free values remain readable without invented labels", () => {
  const result = formatStructuredWorkflowResult({
    api_url: "https://example.test",
    emptyObject: {},
    emptyArray: [],
    matrix: [[1, 2]],
    anonymous: [{ enabled: true }],
    values: [undefined, Symbol("marker")],
    opaque: Symbol("value"),
  });

  expect(result).toContain("- **API URL:** https://example.test");
  expect(result).toContain("_(empty)_");
  expect(result).toContain("_(none)_");
  expect(result).toContain("### 1");
  expect(result).toContain("- **Enabled:** true");
  expect(result).toContain("- undefined");
  expect(result).toContain("- Symbol(marker)");
  expect(result).toContain("Symbol(value)");
});
