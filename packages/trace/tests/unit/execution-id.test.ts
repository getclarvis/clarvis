import { describe, expect, it } from "bun:test";

import { generateExecutionId } from "../../src/execution-id.ts";

describe("generateExecutionId", () => {
  it("prefixes a v4 uuid with exec_", () => {
    expect(generateExecutionId()).toMatch(
      /^exec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("mints a distinct id every call", () => {
    const ids = new Set(Array.from({ length: 64 }, () => generateExecutionId()));
    expect(ids.size).toBe(64);
  });
});
